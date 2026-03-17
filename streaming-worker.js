// streaming-worker.js  — save this, then hard-refresh
import wasmInit, * as pkg from './pkg/blake3_wasm_streaming.js';

let ready = false;

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      console.log('[worker] init msg keys:', Object.keys(msg));
      console.log('[worker] wasmURL =', msg.wasmURL);

      await wasmInit({
        module_or_path: msg.wasmURL,
        memory:         msg.memory,
      });

      ready = true;
      self.postMessage({ type: 'ready' });
      return;
    }

    if (msg.type === 'hash') {
      if (!ready) throw new Error('worker not initialized');
      const { taskId, dataPtr, size, offset, cvPtr } = msg;
      pkg.hash_64k_parcel_to_cv_from_ptr(dataPtr, size, offset, cvPtr);
      self.postMessage({ type: 'done', taskId });
      return;
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      taskId: msg.taskId,
      error: String(err),
    });
  }
};
