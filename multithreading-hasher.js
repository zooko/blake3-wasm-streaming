function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

const DONE_IDX = 0;
const READY_IDX = 1;
const CTRL_WORDS = 11;
const CTRL_BYTES_PADDED = 48;
const CV_LEN = 32;
const SLICE_SIZE = 16384;
const MAX_THREADS = 8;
const STACK_SIZE = 65536;
const WASM_PAGES = 1 << 14;

const AVAIL = WASM_PAGES * 65536
    - CTRL_BYTES_PADDED
    - (MAX_THREADS - 1) * STACK_SIZE;
const DATA_BUF_SIZE =
    1 << (31 - Math.clz32(
        AVAIL * SLICE_SIZE / (SLICE_SIZE + CV_LEN)));

const WASM_URL = new URL(
    './target/wasm32-unknown-unknown/release/blake3_wasm_streaming.wasm',
    import.meta.url,
);
const WORKER_URL = new URL('./hash-worker.js', import.meta.url);

async function waitUntilAtLeast(ctrl, idx, target) {
    for (;;) {
        const cur = Atomics.load(ctrl, idx);
        if (cur >= target) return;
        const r = Atomics.waitAsync(ctrl, idx, cur);
        if (r.async) await r.value;
    }
}

export default async function init() {
    assert(
        typeof Atomics.waitAsync === 'function',
        'Atomics.waitAsync unavailable',
    );

    const wasmBytes =
        await (await fetch(WASM_URL)).arrayBuffer();
    const wasmModule =
        await WebAssembly.compile(wasmBytes);

    const memory = new WebAssembly.Memory({
        initial: WASM_PAGES,
        maximum: WASM_PAGES,
        shared: true,
    });

    const main = await WebAssembly.instantiate(
        wasmModule, { env: { memory } },
    );
    const wasm = main.exports;

    const ctrlPtr = wasm.layout_ctrl_ptr();
    const dataPtr = ctrlPtr + CTRL_BYTES_PADDED;
    const cvPtr = dataPtr + DATA_BUF_SIZE;
    const stacksBase =
        cvPtr + (DATA_BUF_SIZE / SLICE_SIZE) * CV_LEN;

    const ctrl = new Int32Array(
        memory.buffer, ctrlPtr, CTRL_WORDS,
    );
    const data = new Uint8Array(
        memory.buffer, dataPtr, DATA_BUF_SIZE,
    );
    const digest = new Uint8Array(
        memory.buffer, cvPtr, CV_LEN,
    );

    const bgWorkers = MAX_THREADS - 1;
    for (let i = 0; i < bgWorkers; i++) {
        const worker = new Worker(
            WORKER_URL, { type: 'module' },
        );
        worker.postMessage({
            wasmModule, memory, index: i,
            ctrlPtr, dataPtr,
            stackPtr: stacksBase + (i + 1) * STACK_SIZE,
            cvPtr,
        });
    }

    await waitUntilAtLeast(ctrl, READY_IDX, bgWorkers);

    let busy = false;

    function hashBytes(input) {
        assert(!busy, 'busy');
        assert(input.length <= DATA_BUF_SIZE, 'input too large');
        data.set(input);
        wasm.blake3_hash(dataPtr, input.length, cvPtr);
    }

    async function hashParallelBytes(input, threads) {
        assert(!busy, 'busy');
        busy = true;

        const len = input.length;
        assert(len <= DATA_BUF_SIZE, 'input too large');
        data.set(input);

        if (threads === undefined) {
            const maxForLen = (len / SLICE_SIZE) | 0;
            threads = Math.min(
                MAX_THREADS, maxForLen,
                len < SLICE_SIZE * 17 ? 2 : 8,
            );
        }

        if (threads < 2) {
            wasm.blake3_hash(dataPtr, len, cvPtr);
            busy = false;
            return 1;
        }

        wasm.parallel_hash(
            ctrlPtr, dataPtr, len, cvPtr, threads,
        );

        await waitUntilAtLeast(
            ctrl, DONE_IDX, threads - 1,
        );

        const totalCvs = (len + SLICE_SIZE - 1) >>> 14;
        wasm.merge_cv_tree(cvPtr, totalCvs, cvPtr);

        busy = false;
        return threads;
    }

    return {
        maxData: DATA_BUF_SIZE,
        maxThreads: MAX_THREADS,
        hashBytes,
        hashParallelBytes,
        digest,
    };
}
