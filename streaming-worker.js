import wasmInit, * as wasm from './pkg/blake3_wasm_streaming.js';

let ready = false;

function splitU64(n) {
  const x = BigInt(n);
  return {
    lo: Number(x & 0xffffffffn),
    hi: Number((x >> 32n) & 0xffffffffn),
  };
}

self.onmessage = async (e) => {
  const msg = e.data;

  try {
    if (msg.type === 'init') {
      await wasmInit();
      ready = true;
      self.postMessage({ type: 'ready' });
      return;
    }

    if (msg.type === 'hash') {
      if (!ready) {
        throw new Error('worker not initialized');
      }

      const input =
        msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data);

      const { lo, hi } = splitU64(msg.offset);
      const cv = new Uint8Array(wasm.hash_subtree_cv_bytes(input, lo, hi));

      self.postMessage(
        { type: 'result', taskId: msg.taskId, cv: cv.buffer },
        [cv.buffer]
      );
      return;
    }

    throw new Error(`unknown message type: ${msg.type}`);
  } catch (err) {
    self.postMessage({
      type: 'error',
      taskId: msg.taskId,
      error: err?.message ?? String(err),
    });
  }
};
