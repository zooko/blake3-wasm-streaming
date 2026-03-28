function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

const SLICE_SIZE_BYTE = 1;
const SIGNAL_BYTE = 4;
const READY_BYTE = 6;

const CTRL_WORDS = 7;
const CTRL_BYTES_PADDED = 32;
const MIN_SLICE_SIZE = 4096;
const CV_LEN = 32;
const WASM_PAGES = 16384;

const DATA_BUF_SIZE = 1 << 28;
const MAX_THREADS = 8;
const MAX_SLICES = DATA_BUF_SIZE / MIN_SLICE_SIZE;
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
    const outPtr = dataPtr + DATA_BUF_SIZE;
    const stacksBase = outPtr + MAX_SLICES * CV_LEN;

    const ctrl = new Int32Array(memory.buffer, ctrlPtr, CTRL_WORDS);
    const data = new Uint8Array(memory.buffer, dataPtr, DATA_BUF_SIZE);
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
        await waitUntilAtLeast(ctrl, READY_BYTE, bgWorkers);
    }

    let signalSeen = Atomics.load(ctrl, SIGNAL_BYTE);
    let busy = false;

    function loadInput(input) {
        const bytes = normalizeInput(input);
        const len = bytes.length;
        assert(len <= DATA_BUF_SIZE, `input too large: ${len}`);
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

    async function hashParallelBytes(input, totalThreads, sliceSize = 0) {
        assert(!busy, 'busy');
        assert(totalThreads >= 2, 'totalThreads must be at least 2');
        assert(totalThreads <= MAX_THREADS, 'totalThreads too large');

        busy = true;

        try {
            const len = loadInput(input);
            const maxThreadsForLen = len >>> 12;
            assert(
                totalThreads <= maxThreadsForLen,
                'totalThreads too large for input length',
            );

            if (sliceSize !== 0) {
                const maxSliceSize = Math.floor(len / totalThreads);
                assert(
                    (sliceSize & (sliceSize - 1)) === 0,
                    'sliceSize must be a power of two',
                );
                assert(
                    sliceSize >= MIN_SLICE_SIZE,
                    'sliceSize must be at least 4096',
                );
                assert(sliceSize <= len, 'sliceSize too large');
                assert(
                    sliceSize <= maxSliceSize,
                    'sliceSize too large for thread count',
                );
                assert(
                    len <= MAX_SLICES * sliceSize,
                    'sliceSize too small for input length',
                );
            }

            const expected = signalSeen;
            const totalCvs = wasm.parallel_hash(
                ctrlPtr,
                dataPtr,
                len,
                outPtr,
                totalThreads,
                sliceSize,
            );

            await waitForChange(ctrl, SIGNAL_BYTE, expected);
            signalSeen = Atomics.load(ctrl, SIGNAL_BYTE);
            wasm.merge_cv_tree(outPtr, totalCvs, outPtr);

            return {
                totalCvs,
                sliceSize: Atomics.load(ctrl, SLICE_SIZE_BYTE),
            };
        } finally {
            busy = false;
        }
    }

    function hashParallelBytesManual(input, totalThreads, sliceSize) {
        assert(sliceSize !== 0, 'sliceSize must be non-zero');
        return hashParallelBytes(input, totalThreads, sliceSize);
    }

    function hash(input) {
        hashBytes(input);
        return digestHex();
    }

    async function hashParallel(input, totalThreads, sliceSize = 0) {
        await hashParallelBytes(input, totalThreads, sliceSize);
        return digestHex();
    }

    return {
        maxData: DATA_BUF_SIZE,
        maxThreads: MAX_THREADS,
        maxCvs: MAX_SLICES,
        hash,
        hashParallel,
        hashBytes,
        hashParallelBytes,
        hashParallelBytesManual,
        digestHex,
    };
}
