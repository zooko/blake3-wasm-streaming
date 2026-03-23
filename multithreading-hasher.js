const GEN = 0, CHUNK = 1, ACTIVE = 2, DONE = 3, SIGNAL = 4;
const PTR_ALIGN = 16;
const WASM_PAGE = 65536;
const CV_LEN = 32;
const MAX_DATA = 8 * 1024 * 1024;   // 8 MiB default arena
const MAX_THREADS = 256;
const WORKER_STACK = 65536;

function floorPow2(n) {
    return n < 1 ? 0 : 1 << (31 - Math.clz32(n));
}

function alignUp(x, align) {
    return Math.ceil(x / align) * align;
}

function hex(buf) {
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

// ═══ High-level convenience wrapper ═══

export class Blake3Hasher {
    constructor(wasmModule, memory, exports, dataPtr, outPtr, stacksBase) {
        this._module     = wasmModule;
        this._memory     = memory;
        this._exports    = exports;
        this._dataPtr    = dataPtr;
        this._outPtr     = outPtr;
        this._stacksBase = stacksBase;
        this._mt         = null;  // lazy MultithreadingHasher
    }

    static async create(wasmUrl, opts = {}) {
        const maxData = opts.maxData || MAX_DATA;

        const resp  = await fetch(wasmUrl);
        const bytes = await resp.arrayBuffer();
        const wasmModule = await WebAssembly.compile(bytes);

        const memory = new WebAssembly.Memory({
            initial: 512, maximum: 65536, shared: true,
        });

        const { exports } = await WebAssembly.instantiate(wasmModule, {
            env: { memory },
        });

        const heapBase   = exports.__heap_base.value;
        const dataPtr    = alignUp(heapBase, PTR_ALIGN);
        const outPtr     = alignUp(dataPtr + maxData, PTR_ALIGN);
        const stacksBase = alignUp(outPtr + 256 * CV_LEN, PTR_ALIGN);

        const layoutEnd = stacksBase + MAX_THREADS * WORKER_STACK;
        const needPages = Math.ceil(layoutEnd / WASM_PAGE);
        const havePages = memory.buffer.byteLength / WASM_PAGE;
        if (needPages > havePages) memory.grow(needPages - havePages);

        return new Blake3Hasher(wasmModule, memory, exports, dataPtr, outPtr, stacksBase);
    }

    /**
     * Hash a string or Uint8Array synchronously on the main thread.
     * Returns the 32-byte hex digest.
     */
    hash(input) {
        const data = typeof input === 'string'
              ? new TextEncoder().encode(input) : input;
        new Uint8Array(this._memory.buffer).set(data, this._dataPtr);
        this._exports.blake3_hash(this._dataPtr, data.length, this._outPtr);
        return hex(new Uint8Array(this._memory.buffer, this._outPtr, CV_LEN));
    }

    /**
     * Hash using worker threads. Returns a Promise<string> (hex digest).
     * Creates workers lazily on first call.
     */
    async hashParallel(input, numWorkers) {
        const data = typeof input === 'string'
              ? new TextEncoder().encode(input) : input;
        new Uint8Array(this._memory.buffer).set(data, this._dataPtr);

        if (!this._mt || this._mt.numWorkers !== numWorkers) {
            if (this._mt) this._mt.terminate();
            this._mt = new MultithreadingHasher(
                this._module, this._memory, this._exports, numWorkers,
                this._dataPtr, this._outPtr, this._stacksBase, WORKER_STACK,
            );
            await this._mt.init();
        }
        await this._mt.hashAsync(data.length);
        return hex(new Uint8Array(this._memory.buffer, this._outPtr, CV_LEN));
    }

    terminate() {
        if (this._mt) { this._mt.terminate(); this._mt = null; }
    }
}

// ═══ Low-level multithreading hasher (unchanged) ═══

export class MultithreadingHasher {
    constructor(wasmModule, memory, exports, numWorkers, dataPtr, cvPtr, stacksBase, stackSize) {
        this.wasmModule  = wasmModule;
        this.memory      = memory;
        this.exports     = exports;
        this.numWorkers  = numWorkers;
        this.dataPtr     = dataPtr;
        this.cvPtr       = cvPtr;
        this.stacksBase  = stacksBase;
        this.stackSize   = stackSize;
        this.ctrl = new Int32Array(new SharedArrayBuffer(5 * 4));
    }

    async init() {
        const ready = [];
        this.workers = Array.from({ length: this.numWorkers }, (_, i) => {
            const w = new Worker(
                new URL('./hash-worker.js', import.meta.url),
                { type: 'module' },
            );
            ready.push(new Promise(r => { w.onmessage = () => r(); }));
            w.postMessage({
                wasmModule: this.wasmModule, memory: this.memory,
                ctrl: this.ctrl.buffer, index: i,
                dataPtr: this.dataPtr, cvPtr: this.cvPtr,
                stacksBase: this.stacksBase, stackSize: this.stackSize,
            });
            return w;
        });
        await Promise.all(ready);
    }

    hashSync(len) {
        this.exports.blake3_hash(this.dataPtr, len, this.cvPtr);
    }

    hashAsync(len, minBlock = 128 * 1024) {
        return this.hashRegion(len, minBlock).promise;
    }

    hashRegion(len, minBlock = 128 * 1024) {
        let chunk = floorPow2(len / this.numWorkers | 0);
        let active;
        if (chunk >= minBlock) {
            active = this.numWorkers;
        } else {
            chunk = minBlock;
            active = len / minBlock | 0;
        }
        if (active < 2) {
            this.exports.blake3_hash(this.dataPtr, len, this.cvPtr);
            return { promise: Promise.resolve(), activeWorkers: 0 };
        }

        const c = this.ctrl;
        Atomics.store(c, CHUNK,  chunk);
        Atomics.store(c, ACTIVE, active);
        Atomics.store(c, DONE,   0);
        const gen = Atomics.add(c, GEN, 1) + 1;
        Atomics.notify(c, GEN);

        const dispatched = active * chunk;
        if (dispatched < len)
            this.exports.blake3_hash(
                this.dataPtr + dispatched, len - dispatched,
                this.cvPtr + active * 32,
            );

        const r = Atomics.waitAsync(c, SIGNAL, gen - 1);
        const promise = r.async ? r.value : Promise.resolve();
        return { promise, activeWorkers: active };
    }
    terminate() {
        Atomics.store(this.ctrl, GEN, -1);
        Atomics.notify(this.ctrl, GEN);
        for (const w of this.workers) w.terminate();
    }
}

const DEFAULT_WASM = new URL(
    './target/wasm32-unknown-unknown/release/blake3_wasm_streaming.wasm',
    import.meta.url,
);

export default Blake3Hasher.create(DEFAULT_WASM);
