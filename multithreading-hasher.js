function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

const GEN = 0;
const SLICE_SIZE = 1;
const ACTIVE = 2;
const DONE = 3;
const SIGNAL = 4;
const TOTAL_LEN = 5;
const READY = 6;

const CTRL_WORDS = 7;
const CTRL_BYTES_PADDED = 32;
const CV_LEN = 32;
const WASM_PAGES = 16384;

const MAX_DATA = 1 << 29;
const MAX_THREADS = 8;
const MAX_SLICES = MAX_THREADS * 4;
const STACK_SIZE = 65536;

const WASM_URL = new URL(
    './target/wasm32-unknown-unknown/release/blake3_wasm_streaming.wasm',
    import.meta.url,
);
const WORKER_URL = new URL('./hash-worker.js', import.meta.url);

const HEX = Array.from(
    { length: 256 },
    (_, i) => (i + 256).toString(16).slice(1),
);

const textEncoder = new TextEncoder();

async function waitUntilAtLeast(ctrl, idx, target) {
    for (;;) {
        const cur = Atomics.load(ctrl, idx);
        if (cur >= target) return;
        const r = Atomics.waitAsync(ctrl, idx, cur);
        if (r.async) await r.value;
    }
}

async function waitForChange(ctrl, idx, expected) {
    for (;;) {
        const cur = Atomics.load(ctrl, idx);
        if (cur !== expected) return;
        const r = Atomics.waitAsync(ctrl, idx, expected);
        if (r.async) await r.value;
    }
}

function hex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
    return s;
}

function normalizeInput(input) {
    if (typeof input === 'string') return textEncoder.encode(input);
    assert(input instanceof Uint8Array, 'input must be string or Uint8Array');
    return input;
}

export default async function init() {
    assert(
        typeof Atomics.waitAsync === 'function',
        'Atomics.waitAsync unavailable',
    );

    const wasmBytes = await (await fetch(WASM_URL)).arrayBuffer();
    const wasmModule = await WebAssembly.compile(wasmBytes);

    const memory = new WebAssembly.Memory({
        initial: WASM_PAGES,
        maximum: WASM_PAGES,
        shared: true,
    });

    const main = await WebAssembly.instantiate(wasmModule, {
        env: { memory },
    });
    const wasm = main.exports;

    const ctrlPtr = wasm.layout_ctrl_ptr();
    const dataPtr = ctrlPtr + CTRL_BYTES_PADDED;
    const outPtr = dataPtr + MAX_DATA;
    const stacksBase = outPtr + MAX_SLICES * CV_LEN;

    const ctrl = new Int32Array(memory.buffer, ctrlPtr, CTRL_WORDS);
    const data = new Uint8Array(memory.buffer, dataPtr, MAX_DATA);
    const out = new Uint8Array(memory.buffer, outPtr, CV_LEN);

    ctrl.fill(0);

    const bgWorkers = MAX_THREADS - 1;
    for (let i = 0; i < bgWorkers; i++) {
        const worker = new Worker(WORKER_URL, { type: 'module' });
        worker.postMessage({
            wasmModule,
            memory,
            index: i,
            ctrlPtr,
            dataPtr,
            stackPtr: stacksBase + (i + 1) * STACK_SIZE,
            cvPtr: outPtr,
        });
    }

    if (bgWorkers !== 0) {
        await waitUntilAtLeast(ctrl, READY, bgWorkers);
    }

    let signalSeen = Atomics.load(ctrl, SIGNAL);
    let busy = false;

    function loadInput(input) {
        const bytes = normalizeInput(input);
        const len = bytes.length;
        assert(len <= MAX_DATA, `input too large: ${len}`);
        data.set(bytes);
        return len;
    }

    function digestHex() {
        return hex(out);
    }

    function hashBytes(input) {
        assert(!busy, 'busy');
        const len = loadInput(input);
        wasm.blake3_hash(dataPtr, len, outPtr);
    }

    async function hashParallelBytes(input) {
        assert(!busy, 'busy');
        busy = true;

        try {
            const len = loadInput(input);
            const expected = signalSeen;
            const totalCvs = wasm.dispatch_auto(ctrlPtr, dataPtr, len, outPtr);

            if (totalCvs > 1) {
                await waitForChange(ctrl, SIGNAL, expected);
                signalSeen = Atomics.load(ctrl, SIGNAL);
                wasm.merge_cv_tree(outPtr, totalCvs, outPtr);
            }

            return {
                totalCvs,
                sliceSize: totalCvs > 1 ? Atomics.load(ctrl, SLICE_SIZE) : 0,
                threads: totalCvs > 1 ? Atomics.load(ctrl, ACTIVE) + 1 : 1,
                direct: totalCvs === 1,
            };
        } finally {
            busy = false;
        }
    }

    async function hashParallelBytesManual(input, totalThreads, minSliceSize) {
        assert(!busy, 'busy');
        assert(totalThreads >= 2, 'threadCount must be at least 2');
        assert(totalThreads <= MAX_THREADS, 'threadCount too large');

        busy = true;

        try {
            const len = loadInput(input);
            const expected = signalSeen;
            const totalCvs = wasm.dispatch(
                ctrlPtr,
                dataPtr,
                len,
                outPtr,
                totalThreads - 1,
                minSliceSize,
            );

            if (totalCvs > 1) {
                await waitForChange(ctrl, SIGNAL, expected);
                signalSeen = Atomics.load(ctrl, SIGNAL);
                wasm.merge_cv_tree(outPtr, totalCvs, outPtr);
            }

            return {
                totalCvs,
                chosenSliceSize: totalCvs > 1
                    ? Atomics.load(ctrl, SLICE_SIZE)
                    : 0,
            };
        } finally {
            busy = false;
        }
    }

    function hash(input) {
        hashBytes(input);
        return digestHex();
    }

    async function hashParallel(input) {
        await hashParallelBytes(input);
        return digestHex();
    }

    return {
        maxData: MAX_DATA,
        maxThreads: MAX_THREADS,
        hash,
        hashParallel,
        hashBytes,
        hashParallelBytes,
        hashParallelBytesManual,
        digestHex,
    };
}
