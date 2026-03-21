const WORKER_STACK = 65536;

export class StreamingHasher {
    constructor(
        wasmModule,
        memory,
        workerCount,
        { dataPtr, cvPtr, parcelSize, maxParcels }
    ) {
        this.wasmModule = wasmModule;
        this.memory = memory;
        this.workerCount = workerCount;

        this.dataPtr = dataPtr;
        this.cvPtr = cvPtr;
        this.parcelSize = parcelSize;
        this.maxParcels = maxParcels;

        this.workers = [];
        this.pendingTasks = new Map();
        this.nextTaskId = 1;

        this._initPromise = null;
        this._initialized = false;
    }

    init() {
        if (this._initialized) return Promise.resolve();
        if (this._initPromise) return this._initPromise;

        this._initPromise = Promise.all(
            Array.from({ length: this.workerCount }, (_, w) => {
                return new Promise((resolve, reject) => {
                    const worker = new Worker(new URL('./streaming-worker.js', import.meta.url), { type: 'module' });
                    worker.onerror = (event) => {
                        reject(
                            new Error(
                                `Worker init failed: ${event.message || 'unknown'}`
                                    + (event.filename ? ` at ${event.filename}` : '')
                                    + (event.lineno ? `:${event.lineno}` : '')
                                    + (event.colno ? `:${event.colno}` : '')
                            )
                        );
                    };

                    worker.onmessageerror = () => {
                        reject(new Error('Worker message deserialization failed'));
                    };

                    worker.onmessage = (e) => {
                        const msg = e.data;

                        if (msg.type === 'inited') {
                            resolve();
                            return;
                        }

                        if (msg.type === 'done') {
                            const pending = this.pendingTasks.get(msg.taskId);
                            if (!pending) return;

                            pending.remaining--;
                            if (pending.remaining === 0) {
                                this.pendingTasks.delete(msg.taskId);
                                pending.resolve();
                            }
                            return;
                        }

                        if (msg.type === 'error') {
                            if (msg.taskId != null) {
                                const pending = this.pendingTasks.get(msg.taskId);
                                if (pending) {
                                    this.pendingTasks.delete(msg.taskId);
                                    pending.reject(new Error(msg.error || 'worker error'));
                                    return;
                                }
                            }
                            reject(new Error(msg.error || 'worker init error'));
                        }
                    };

                    worker.onerror = (err) => {
                        reject(err);
                    };

                    worker.postMessage({
                        type: 'init',
                        wasmModule: this.wasmModule,
                        memory: this.memory,
                        dataPtr: this.dataPtr,
                        cvPtr: this.cvPtr
                    });

                    this.workers.push(worker);
                });
            })
        ).then(() => {
            this._initialized = true;
        });

        return this._initPromise;
    }

    hashParcels(numParcels) {
        if (!this._initialized) {
            return Promise.reject(new Error('StreamingHasher not initialized'));
        }
        if (numParcels === 0) return Promise.resolve();
        if (numParcels > this.maxParcels) {
            return Promise.reject(new Error(`too many parcels: ${numParcels}`));
        }

        const activeWorkers = Math.min(this.workers.length, numParcels);
        const taskId = this.nextTaskId++;

        let resolve, reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });

        this.pendingTasks.set(taskId, {
            remaining: activeWorkers,
            resolve,
            reject,
        });

        const base = (numParcels / activeWorkers) | 0;
        const extra = numParcels % activeWorkers;

        let startParcel = 0;
        for (let w = 0; w < activeWorkers; w++) {
            const parcelCount = base + (w < extra ? 1 : 0);

            this.workers[w].postMessage({
                type: 'hash_range',
                taskId,
                startParcel,
                parcelCount,
            });

            startParcel += parcelCount;
        }

        return promise;
    }
}
