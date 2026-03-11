import init, * as wasm from './blake3-wasm-streaming/pkg/blake3_wasm_streaming.js';

export class StreamingHasher {
  async init() {
    // main-thread wasm init goes here
    // create shared memory
    // initialize wasm on main thread
    // spawn workers
    // post { type: "init", memory } to each worker
  }
}
