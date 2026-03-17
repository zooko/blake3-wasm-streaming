const PARCEL_LEN = 65536;
const CV_LEN = 32;

export class StreamingHasher {
    constructor(workerCount = navigator.hardwareConcurrency || 4) {
        this.workerCount = workerCount;
        this.workers = [];
        this.pkg = null;
        this.memory = null;
        this.module = null;
        this.pendingTasks = new Map();
        this.nextTaskId = 0;
        this.inflightPerWorker = [];
    }

    async init(wasmPath = './pkg/blake3_wasm_streaming_bg.wasm') {
        // 1. Shared memory for main thread + all workers
        this.memory = new WebAssembly.Memory({
            initial: 4096,
            maximum: 16384,   // matches --max-memory from .cargo/config.toml
            shared: true,
        });

        // 2. Absolute URL so workers resolve it correctly
        const wasmURL = new URL(wasmPath, import.meta.url).href;

        // 3. Main-thread init (for alloc, parent_cv, root_hash, etc.)
        this.pkg = await import(
            new URL('./pkg/blake3_wasm_streaming.js', import.meta.url).href
        );
        await this.pkg.default({
            module_or_path: wasmURL,
            memory: this.memory,
        });

        // 4. Spawn workers
        const readyPromises = [];
        for (let i = 0; i < this.workerCount; i++) {
            const w = new Worker(
                new URL('./streaming-worker.js', import.meta.url),
                { type: 'module' },
            );

            readyPromises.push(new Promise((resolve, reject) => {
                const timeout = setTimeout(
                    () => reject(new Error('worker init timeout')), 10000
                );

                // w.onerror INSIDE the Promise so reject is in scope
                w.onerror = (evt) => {
                    clearTimeout(timeout);
                    reject(new Error(
                        `Worker script failed: ${evt.message || 'unknown'}`
                    ));
                };

                w.onmessage = (e) => {
                    clearTimeout(timeout);
                    if (e.data.type === 'ready') resolve();
                    else if (e.data.type === 'error')
                        reject(new Error(e.data.error));
                };
            }));

            // Key name "wasmURL" must match worker's msg.wasmURL exactly
            w.postMessage({
                type: 'init',
                wasmURL,
                memory: this.memory,
            });

            this.workers.push(w);
            this.inflightPerWorker.push(0);
        }

        await Promise.all(readyPromises);

        // 5. Switch all workers to hash-result handler
        for (const w of this.workers) {
            w.onmessage = (e) => this.#handleResult(e.data);
        }
    }

    #handleResult(data) {
        const task = this.pendingTasks.get(data.taskId);
        if (!task) return;
        this.pendingTasks.delete(data.taskId);
        const idx = this.workers.indexOf(task.worker);
        if (idx >= 0) this.inflightPerWorker[idx]--;

        if (data.type === 'done') {
            task.resolve();
        } else {
            task.reject(new Error(data.error));
        }
    }

    #leastLoadedWorker() {
        let minIdx = 0;
        for (let i = 1; i < this.workerCount; i++) {
            if (this.inflightPerWorker[i] < this.inflightPerWorker[minIdx]) minIdx = i;
        }
        return minIdx;
    }

    /**
     * Hash a parcel that's already in shared linear memory.
     * @param {number} dataPtr  — pointer to parcel data in shared memory
     * @param {number} size     — byte length
     * @param {BigInt} offset   — BLAKE3 stream offset
     * @param {number} cvPtr    — pointer where the 32-byte CV will be written
     * @returns {Promise<void>}
     */
    dispatchHash(dataPtr, size, offset, cvPtr) {
        const taskId = this.nextTaskId++;
        const workerIdx = this.#leastLoadedWorker();
        const worker = this.workers[workerIdx];
        this.inflightPerWorker[workerIdx]++;

        const promise = new Promise((resolve, reject) => {
            this.pendingTasks.set(taskId, { resolve, reject, worker });
        });

        worker.postMessage({ type: 'hash', taskId, dataPtr, size, offset, cvPtr });

        return promise;
    }

    terminate() {
        for (const w of this.workers) w.terminate();
        this.workers = [];
        this.inflightPerWorker = [];
        this.pendingTasks.clear();
    }
}
