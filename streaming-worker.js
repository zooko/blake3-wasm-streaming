import init, * as wasm from './blake3-wasm-streaming/pkg/blake3_wasm_streaming.js';

let ready = false;

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    // worker init goes here
    await init(/* instantiate with msg.memory */);
    ready = true;
    self.postMessage({ type: 'ready' });
    return;
  }

  if (msg.type === 'hash') {
    // hashing work here
  }
};
