const CV_LEN = 32;

let hashFn = null;

let dataPtrBase = 0;
let cvPtrBase = 0;
let PARCEL_SIZE = 16 * 1024;

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

self.onmessage = async (e) => {
    const msg = e.data;

    try {
        if (msg.type === 'init') {
            const instance = await WebAssembly.instantiate(msg.wasmModule, {
                env: { memory: msg.memory },
            });

            const ex = instance.exports;

            dataPtrBase = msg.dataPtr;
            cvPtrBase = msg.cvPtr;

            hashFn = ex.hash_parcel_to_cv_from_ptr;
            assert(typeof hashFn === 'function', 'missing hash_parcel_to_cv_from_ptr export');

            postMessage({ type: 'inited' });
            return;
        }

        if (msg.type === 'hash_range') {
///xxx replace taskId with offset hashed
            const { taskId, startParcel, parcelCount } = msg;

            let dataPtr = dataPtrBase + startParcel * PARCEL_SIZE;
            let cvPtr = cvPtrBase + startParcel * CV_LEN;

            for (let i = 0; i < parcelCount; i++) {
                hashFn(
                    dataPtr,
                    cvPtr
                );

                dataPtr += PARCEL_SIZE;
                cvPtr += CV_LEN;
            }

            postMessage({ type: 'done', taskId });
            return;
        }
    } catch (err) {
        postMessage({
            type: 'error',
            taskId: msg.taskId,
            error: String(err?.stack || err),
        });
    }
};
