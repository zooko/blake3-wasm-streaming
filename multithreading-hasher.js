function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

const SIGNAL_BYTE = 3;
const READY_BYTE = 5;

const CTRL_WORDS = 6;
const CTRL_BYTES_PADDED = 32;
const CV_LEN = 32;
const SLICE_SIZE = 16384;
const MAX_THREADS = 8;
const STACK_SIZE = 65536;
const WASM_PAGES = 1 << 14;

// DATA_BUF_SIZE: largest power of 2 such that
//   CTRL + DATA + CVs + stacks fits in WASM_PAGES * 64 KiB.
// Each data byte costs (1 + CV_LEN / SLICE_SIZE) bytes total.
const AVAIL = WASM_PAGES * 65536
    - CTRL_BYTES_PADDED
    - MAX_THREADS * STACK_SIZE;
const DATA_BUF_SIZE =
    1 << (31 - Math.clz32(
        AVAIL * SLICE_SIZE / (SLICE_SIZE + CV_LEN)));

const MAX_SLICES = DATA_BUF_SIZE / SLICE_SIZE;

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

    function digestHex() {
        return hex(out);
    }

    function hashBytes(input) {
        const bytes = normalizeInput(input);
        const len = bytes.length;
        assert(len <= DATA_BUF_SIZE, 'input too large');
        data.set(bytes);
        wasm.blake3_hash(dataPtr, len, outPtr);
    }

    function hash(input) {
        hashBytes(input);
        return digestHex();
    }

    async function hashParallelBytes(
        input,
        maxThreads = MAX_THREADS,
    ) {
        assert(!busy, 'busy');
        busy = true;

        const bytes = normalizeInput(input);
        const len = bytes.length;
        assert(len <= DATA_BUF_SIZE, 'input too large');
        data.set(bytes);

        const threads =
            Math.min(maxThreads, (len / SLICE_SIZE) | 0);

        if (threads < 2) {
            wasm.blake3_hash(dataPtr, len, outPtr);
            busy = false;
            return { totalCvs: 1, threads: 1 };
        }

        const expected = signalSeen;
        const totalCvs = wasm.parallel_hash(
            ctrlPtr, dataPtr, len, outPtr, threads,
        );

        await waitForChange(ctrl, SIGNAL_BYTE, expected);
        signalSeen = Atomics.load(ctrl, SIGNAL_BYTE);

        wasm.merge_cv_tree(outPtr, totalCvs, outPtr);
        busy = false;
        return { totalCvs, threads };
    }

    async function hashParallel(
        input,
        maxThreads = MAX_THREADS,
    ) {
        await hashParallelBytes(input, maxThreads);
        return digestHex();
    }

    return {
        maxData: DATA_BUF_SIZE,
        maxThreads: MAX_THREADS,
        maxCvs: MAX_SLICES,
        sliceSize: SLICE_SIZE,
        hash,
        hashParallel,
        hashBytes,
        hashParallelBytes,
        digestHex,
    };
}
