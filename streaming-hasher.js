const CV_LEN = 32;
const WORKER_STACK = 65536;
const STACK_ALIGN = 16;

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

export class StreamingHasher {
    constructor(
        wasmModule,
        memory,
        workerCount,
        { dataPtr, cvPtr, stacksBase, parcelSize, maxParcels },
    ) {
        this.workers = [];
        this.memory = memory;
        this.wasmModule = wasmModule;
        this.pendingTasks = new Map();
        this.nextTaskId = 0;
        this.inflightPerWorker = [];
        this.workerCount = workerCount;
        this.dataPtr = dataPtr;
        this.cvPtr = cvPtr;
        this.stacksBase = stacksBase;
        this.parcelSize = parcelSize;
        this.maxParcels = maxParcels;
    }

    async init() {
        await this.spawnWorkers(this.workerCount);
    }

    async spawnWorkers(count) {
        assert(this.workers.length === 0, 'spawnWorkers called more than once');
        assert(this.inflightPerWorker.length === 0,
            'spawnWorkers called after inflight state was created');
       assert(this.pendingTasks.size === 0,
            'spawnWorkers called with pending tasks still present');

        this.workers = [];

        assert(Number.isInteger(count), `spawnWorkers: bad count ${count}`);
        assert(count > 0, `spawnWorkers: count must be > 0, got ${count}`);
        assert(this.stacksBase !== undefined, 'spawnWorkers: missing stacksBase');
        assert(this.workerCount <= 0 || count <= this.workerCount, 'spawnWorkers: bad count');
        assert(this.stacksBase % STACK_ALIGN === 0, `stacksBase not ${STACK_ALIGN}-byte aligned`);

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

            const stackTop = this.stacksBase + (i + 1) * WORKER_STACK;
            assert(stackTop % STACK_ALIGN === 0, `stackTop not ${STACK_ALIGN}-byte aligned`);
            w.postMessage({
                type: 'init',
                wasmModule: this.wasmModule,
                memory: this.memory,
                stackTop,
            });

            this.workers.push(w);
            this.inflightPerWorker.push(0);
        }

        await Promise.all(readyPromises);

        for (const w of this.workers) {
            w.onmessage = (e) => this.#handleResult(e.data);
        }
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
        // xxx re-add the feature of dispatching to the least loaded worker. But do not make `workerIdx` optional! Either remove `workerIdx` so that the only way to call this function is without specifying the nn

        assert(workerIdx >= 0 && workerIdx < this.workers.length, `bad workerIdx ${workerIdx}`);

        const taskId = this.nextTaskId++;
        this.inflightPerWorker[workerIdx]++;

        const promise = new Promise((resolve, reject) => {
            this.pendingTasks.set(taskId, { resolve, reject, workerIdx });
        });

        this.workers[workerIdx].postMessage({ type: 'hash', taskId, jobs });
        return promise;
    }

    //xxx we need to pass the starting offset
    hashParcels(numParcels) {
        assert(Number.isInteger(numParcels), `hashParcels: numParcels must be int, got ${numParcels}`);
        assert(
            numParcels >= 0 && numParcels <= this.maxParcels,
            `hashParcels: numParcels=${numParcels} out of range 0..${this.maxParcels}`,
        );
        assert(this.workers.length > 0, 'hashParcels: no workers');

        if (!Number.isInteger(numParcels)) {
            throw new Error(`hashParcels: numParcels must be int, got ${numParcels}`);
        }
        if (numParcels < 0 || numParcels > this.maxParcels) {
            throw new Error(
                `hashParcels: numParcels=${numParcels} out of range 0..${this.maxParcels}`,
            );
        }
        if (this.workers.length === 0) {
            throw new Error('hashParcels: no workers');
        }

        const jobsPerWorker = Array.from(
            { length: this.workers.length },
            () => [],
        );

        for (let i = 0; i < numParcels; i++) {
            jobsPerWorker[i % this.workers.length].push({
                dataPtr: this.dataPtr + i * this.parcelSize,
                size: this.parcelSize,
                offset: BigInt(i) * BigInt(this.parcelSize),
                cvPtr: this.cvPtr + i * CV_LEN,
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
}
