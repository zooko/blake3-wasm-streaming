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

const CV_LEN = 32;
const WASM_PAGES = 65536;

const WASM_URL = new URL(
    './target/wasm32-unknown-unknown/release/blake3_wasm_streaming.wasm',
    import.meta.url,
);
const WORKER_URL = new URL('./hash-worker.js', import.meta.url);

const encoder = new TextEncoder();
const HEX = Array.from(
    { length: 256 },
    (_, i) => (i + 256).toString(16).slice(1),
);

function toBytes(input) {
    if (typeof input === 'string') return encoder.encode(input);
    assert(input instanceof Uint8Array, 'expected string or Uint8Array');
    return input;
}

function hex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
    return s;
}

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

export default async function init() {
    assert(typeof Atomics.waitAsync === 'function', 'Atomics.waitAsync unavailable');

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
    const dataPtr = wasm.layout_data_ptr();
    const outPtr = wasm.layout_out_ptr();
    const stacksBase = wasm.layout_stacks_base();
    const stackSize = wasm.config_stack_size();

    const maxData = wasm.config_max_data();
    const maxThreads = wasm.config_max_threads();
    const ctrlWords = wasm.config_ctrl_words();

    const ctrl = new Int32Array(memory.buffer, ctrlPtr, ctrlWords);
    const heap = new Uint8Array(memory.buffer);

    const workers = new Array(maxThreads - 1);
    for (let i = 0; i < workers.length; i++) {
        const worker = new Worker(WORKER_URL, { type: 'module' });
        worker.postMessage({
            wasmModule,
            memory,
            index: i,
            ctrlPtr,
            dataPtr,
            cvPtr: outPtr,
            stackPtr: stacksBase + (i + 1) * stackSize,
        });
        workers[i] = worker;
    }

    if (workers.length !== 0) {
        await waitUntilAtLeast(ctrl, READY, workers.length);
    }

    let signalSeen = Atomics.load(ctrl, SIGNAL);
    let busy = false;

    function loadInput(input) {
        const bytes = toBytes(input);
        assert(bytes.length <= maxData, 'input too large');
        heap.set(bytes, dataPtr);
        return bytes.length;
    }

    function readDigestHex() {
        return hex(new Uint8Array(memory.buffer, outPtr, CV_LEN));
    }

    function hash(input) {
        assert(!busy, 'busy');
        const len = loadInput(input);
        wasm.blake3_hash(dataPtr, len, outPtr);
        return readDigestHex();
    }

    async function hashParallel(input) {
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

            return readDigestHex();
        } finally {
            busy = false;
        }
    }

    return {
        maxData,
        maxThreads,
        hash,
        hashParallel,
    };
}
