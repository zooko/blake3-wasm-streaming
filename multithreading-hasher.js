function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

const DONE_IDX = 0;
const READY_IDX = 1;
const CTRL_WORDS = 11;
const CTRL_BYTES_PADDED = 48;

const DIGEST_LEN = 32;
const NODE_LEN = DIGEST_LEN << 1;
const SLICE_SIZE = 16384;

const MAX_THREADS = 8;
const STACK_SIZE = 1 << 20;

const DATA_BUF_SIZE = 1 << 29;            // 512 MiB
const CV_AREA_SIZE =
      (DATA_BUF_SIZE / SLICE_SIZE) * NODE_LEN;  // 2 MiB
const WASM_PAGES = 1 << 14;               // 1 GiB, plenty of slack

    //'./target/wasm32-unknown-unknown/debug/blake3_wasm_streaming.wasm',
    // './target/wasm32-unknown-unknown/release/blake3_wasm_streaming.wasm',
const WASM_URL = new URL(
    './target/wasm32-unknown-unknown/release/blake3_wasm_streaming.wasm',
    import.meta.url,
);
const WORKER_URL = new URL('./hash-worker.js', import.meta.url);

// It just really bothers me that people use `Math.min` for integers. That's a type error. That's
// wrong. This is right.
function min(...xs) {
    let m = xs[0];
    for (let i = 1; i < xs.length; i++) {
        if (xs[i] < m) m = xs[i];
    }
    return m;
}

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

    wasm.quick_startup_self_test();

    const ctrlPtr = wasm.layout_ctrl_ptr();
    const dataPtr = ctrlPtr + CTRL_BYTES_PADDED;
    const cvPtr = dataPtr + DATA_BUF_SIZE;
    const stacksBase =
          cvPtr + (DATA_BUF_SIZE / SLICE_SIZE) * NODE_LEN;

    const ctrl = new Int32Array(
        memory.buffer, ctrlPtr, CTRL_WORDS,
    );
    const data = new Uint8Array(
        memory.buffer, dataPtr, DATA_BUF_SIZE,
    );
    const digest = new Uint8Array(
        memory.buffer, cvPtr, DIGEST_LEN,
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
        return new Uint8Array(digest);
    }

    async function hashParallelBytes(input, threads) {
        assert(!busy, 'busy');
        busy = true;

        const len = input.length;
        assert(len <= DATA_BUF_SIZE, 'input too large');
        data.set(input);

        if (threads === undefined) {
            // tuned for iPhone 16 Pro
            threads = len < SLICE_SIZE * 17 ? 2 : 8;
        }
        threads = min(threads, MAX_THREADS, (len / SLICE_SIZE) | 0);

        if (threads < 2) {
            wasm.blake3_hash(dataPtr, len, cvPtr);
            busy = false;
            return new Uint8Array(digest);
        }

        wasm.parallel_hash(
            ctrlPtr, dataPtr, len, cvPtr, threads,
        );

        await waitUntilAtLeast(
            ctrl, DONE_IDX, threads - 1,
        );

        const full = len & ~(SLICE_SIZE - 1);
        wasm.reduce_full_slice_nodes_and_tail(
            cvPtr,
            full >>> 14,
            dataPtr + full,
            len - full,
            cvPtr,
        );

        busy = false;
        return new Uint8Array(digest);
    }

    return {
        maxData: DATA_BUF_SIZE,
        maxThreads: MAX_THREADS,
        hashBytes,
        hashParallelBytes
    };
}
