let hashFn = null;

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

self.onmessage = async (e) => {
    const msg = e.data;
    try {
        if (msg.type === 'init') {
            const { wasmModule, memory, stackTop } = msg;

            const instance = await WebAssembly.instantiate(wasmModule, {
                env: { memory },
            });
            const ex = instance.exports;

            assert(
                ex.__stack_pointer instanceof WebAssembly.Global,
                'missing exported __stack_pointer',
            );
            assert((stackTop & 15) === 0, `stackTop not 16-byte aligned: ${stackTop}`);
            ex.__stack_pointer.value = stackTop;

            hashFn = ex.hash_64k_parcel_to_cv_from_ptr;
            assert(typeof hashFn === 'function', 'missing hash_64k_parcel_to_cv_from_ptr export');

            self.postMessage({ type: 'ready' });
            return;
        }

        assert(msg.type === 'hash', `unexpected message type: ${msg.type}`);
        assert(hashFn !== null, 'worker used before init');

        const { taskId, jobs } = msg;
        for (const job of jobs) {
            hashFn(job.dataPtr, job.size, job.offset, job.cvPtr);
        }
        self.postMessage({ type: 'done', taskId });
    } catch (err) {
        self.postMessage({
            type: 'error',
            taskId: msg.taskId,
            error: String(err),
        });
    }
};
