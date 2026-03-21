const CV_LEN = 32;

let hashFn = null;

let dataPtrBase = 0;
let cvPtrBase = 0;
let parcelSize = 0;
let stackPtr = 0;

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
            parcelSize = msg.parcelSize;
            stackPtr = msg.stackPtr;

            hashFn = ex.hash_64k_parcel_to_cv_from_ptr;
            assert(typeof hashFn === 'function', 'missing hash_64k_parcel_to_cv_from_ptr export');

            postMessage({ type: 'inited' });
            return;
        }

        if (msg.type === 'hash_range') {
            const { taskId, startParcel, parcelCount } = msg;

            let dataPtr = dataPtrBase + startParcel * parcelSize;
            let cvPtr = cvPtrBase + startParcel * CV_LEN;
            let offset = BigInt(startParcel) * BigInt(parcelSize);
            const offsetStep = BigInt(parcelSize);

            for (let i = 0; i < parcelCount; i++) {
                hashFn(
                    dataPtr,
                    parcelSize,
                    offset,
                    cvPtr
                );

                dataPtr += parcelSize;
                cvPtr += CV_LEN;
                offset += offsetStep;
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
