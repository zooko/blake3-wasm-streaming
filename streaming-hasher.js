const CV_LEN = 32;
const WORKER_STACK = 65536;

function buildImports(wasmModule, memory) {
    const modImports = WebAssembly.Module.imports(wasmModule);
    const imports = {};
    for (const imp of modImports) {
        if (!imports[imp.module]) imports[imp.module] = {};
        if (imp.kind === 'memory') {
            imports[imp.module][imp.name] = memory;
        } else if (imp.kind === 'function') {
            imports[imp.module][imp.name] = () => {};
        } else if (imp.kind === 'table') {
            imports[imp.module][imp.name] = new WebAssembly.Table({ initial: 128, element: 'anyfunc' });
        } else if (imp.kind === 'global') {
            imports[imp.module][imp.name] = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
        }
    }
    return imports;
}

export class StreamingHasher {
    constructor() {
        this.workers = [];
        this.wasm = null;       // main-thread instance.exports
        this.memory = null;     // shared WebAssembly.Memory
        this.wasmModule = null; // compiled WebAssembly.Module
        this.pendingTasks = new Map();
        this.nextTaskId = 0;
        this.inflightPerWorker = [];
    }

    /**
     * Compile the WASM module and create a main-thread instance.
     * Does NOT spawn workers — call spawnWorkers() separately.
     */
    async init(wasmPath = '.../target/wasm32-unknown-unknown/release/blake3_wasm_streaming.wasm') {
        this.memory = new WebAssembly.Memory({
            initial: 256,
            maximum: 16384,
            shared: true,
        });

        const url = new URL(wasmPath, import.meta.url).href;
        this.wasmModule = await WebAssembly.compileStreaming(fetch(url));

        const imports = buildImports(this.wasmModule, this.memory);
        const instance = await WebAssembly.instantiate(this.wasmModule, imports);
        console.log('xxx instantiate result:', instance);
        this.wasm = instance.exports;
    }

    /**
     * Spawn (or replace) the worker pool.
     * Each worker gets its own WASM instance sharing the same memory,
     * with a dedicated stack region for thread safety.
     */
    async spawnWorkers(count) {
        this.terminateWorkers();

        // Allocate per-worker stack regions (leaked — acceptable for benchmark lifecycle)
        const stacksBase = this.wasm.alloc(count * WORKER_STACK);

        const readyPromises = [];
        for (let i = 0; i < count; i++) {
            const w = new Worker(
                new URL('./streaming-worker.js', import.meta.url),
                { type: 'module' },
            );

            readyPromises.push(new Promise((resolve, reject) => {
                const timeout = setTimeout(
                    () => reject(new Error(`Worker ${i} init timeout`)), 10000,
                );
                w.onerror = (evt) => {
                    clearTimeout(timeout);
                    reject(new Error(`Worker ${i} failed: ${evt.message || 'unknown'}`));
                };
                w.onmessage = (e) => {
                    clearTimeout(timeout);
                    if (e.data.type === 'ready') resolve();
                    else if (e.data.type === 'error') reject(new Error(e.data.error));
                };
            }));

            // Stack grows downward — pass the top of this worker's region
            w.postMessage({
                type: 'init',
                wasmModule: this.wasmModule,
                memory: this.memory,
                stackTop: stacksBase + (i + 1) * WORKER_STACK,
            });

            this.workers.push(w);
            this.inflightPerWorker.push(0);
        }

        await Promise.all(readyPromises);

        for (const w of this.workers) {
            w.onmessage = (e) => this.#handleResult(e.data);
        }
    }

    terminateWorkers() {
        for (const w of this.workers) w.terminate();
        this.workers = [];
        this.inflightPerWorker = [];
        for (const task of this.pendingTasks.values()) {
            task.reject(new Error('workers terminated'));
        }
        this.pendingTasks.clear();
    }

    #handleResult(data) {
        const task = this.pendingTasks.get(data.taskId);
        if (!task) return;
        this.pendingTasks.delete(data.taskId);
        this.inflightPerWorker[task.workerIdx]--;
        if (data.type === 'done') task.resolve();
        else task.reject(new Error(data.error));
    }

    #leastLoadedWorker() {
        let minIdx = 0;
        for (let i = 1; i < this.workers.length; i++) {
            if (this.inflightPerWorker[i] < this.inflightPerWorker[minIdx]) minIdx = i;
        }
        return minIdx;
    }

    #dispatch(jobs, workerIdx) {
        if (workerIdx === undefined) workerIdx = this.#leastLoadedWorker();
        const taskId = this.nextTaskId++;
        this.inflightPerWorker[workerIdx]++;

        const promise = new Promise((resolve, reject) => {
            this.pendingTasks.set(taskId, { resolve, reject, workerIdx });
        });

        this.workers[workerIdx].postMessage({ type: 'hash', taskId, jobs });
        return promise;
    }

    /** Dispatch a single parcel to a worker. offset is a plain Number. */
    dispatchHash(dataPtr, size, offset, cvPtr) {
        return this.#dispatch([{ dataPtr, size, offset, cvPtr }]);
    }

    /**
     * Hash numParcels consecutive parcels, distributing across all workers.
     * One postMessage per worker (batch dispatch). Returns when all done.
     */
    hashParcels(dataBase, parcelSize, numParcels, cvBase) {
        const jobsPerWorker = Array.from({ length: this.workers.length }, () => []);
        for (let i = 0; i < numParcels; i++) {
            jobsPerWorker[i % this.workers.length].push({
                dataPtr: dataBase + i * parcelSize,
                size: parcelSize,
                offset: i * parcelSize,
                cvPtr: cvBase + i * CV_LEN,
            });
        }
        const promises = [];
        for (let w = 0; w < this.workers.length; w++) {
            if (jobsPerWorker[w].length > 0) {
                promises.push(this.#dispatch(jobsPerWorker[w], w));
            }
        }
        return Promise.all(promises);
    }

    /** Main-thread direct hash (no workers). offset is a plain Number. */
    hashDirect(dataPtr, size, offset, cvPtr) {
        this.wasm.hash_64k_parcel_to_cv_from_ptr(dataPtr, size, BigInt(offset), cvPtr);
    }
}
