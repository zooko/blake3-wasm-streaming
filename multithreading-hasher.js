const WASM_URL = new URL(
  './target/wasm32-unknown-unknown/release/blake3_wasm_streaming.wasm',
  import.meta.url,
);

const WORKER_URL = new URL('./hash-worker.js', import.meta.url);

const PAGE = 65536;
const CV_LEN = 32;

// ctrl indices
const SIGNAL = 4;
const READY = 6;

const encoder = new TextEncoder();

function toBytes(input) {
  if (typeof input === 'string') {
    return encoder.encode(input);
  }
  if (input instanceof Uint8Array) {
    return input;
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  throw new TypeError('input must be a string, Uint8Array, or ArrayBuffer');
}

function hex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function waitUntilAtLeast(ctrl, idx, target) {
  while (true) {
    const cur = Atomics.load(ctrl, idx);
    if (cur >= target) return;

    const r = Atomics.waitAsync(ctrl, idx, cur);
    if (r.async) {
      await r.value;
    }
  }
}

async function waitForChange(ctrl, idx, expected) {
  if (Atomics.load(ctrl, idx) !== expected) return;

  const r = Atomics.waitAsync(ctrl, idx, expected);
  if (r.async) {
    await r.value;
  }
}

async function init() {
  if (typeof Atomics.waitAsync !== 'function') {
    throw new Error('Atomics.waitAsync is unavailable in this browser');
  }

  const wasmBytes = await (await fetch(WASM_URL)).arrayBuffer();
  const wasmModule = await WebAssembly.compile(wasmBytes);

  const memory = new WebAssembly.Memory({
    initial: 512,
    maximum: 65536,
    shared: true,
  });

  const main = await WebAssembly.instantiate(wasmModule, {
    env: { memory },
  });
  const wasm = main.exports;

  const needPages = wasm.layout_required_pages();
  const havePages = memory.buffer.byteLength / PAGE;
  if (needPages > havePages) {
    memory.grow(needPages - havePages);
  }

  const ctrlPtr = wasm.layout_ctrl_ptr();
  const dataPtr = wasm.layout_data_ptr();
  const outPtr = wasm.layout_out_ptr();
  const stacksBase = wasm.layout_stacks_base();

  const maxData = wasm.config_max_data();
  const maxThreads = wasm.config_max_threads();
  const minBlock = wasm.config_min_block();
  const ctrlWords = wasm.config_ctrl_words();
  const stackSize = wasm.config_stack_size();

  wasm.clear_ctrl(ctrlPtr);

  const ctrl = new Int32Array(memory.buffer, ctrlPtr, ctrlWords);
  const heap = new Uint8Array(memory.buffer);

  const bgWorkers = maxThreads - 1;
  for (let i = 0; i < bgWorkers; i++) {
    const worker = new Worker(WORKER_URL, { type: 'module' });
    worker.postMessage({
      wasmModule,
      memory,
      index: i,
      ctrlPtr,
      dataPtr,
      cvPtr: outPtr,
      stacksBase,
      stackSize,
    });
  }

  if (bgWorkers > 0) {
    await waitUntilAtLeast(ctrl, READY, bgWorkers);
  }

  let signalSeen = Atomics.load(ctrl, SIGNAL);
  let busy = false;

  function ensureNotBusy() {
    if (busy) {
      throw new Error('hasher is busy');
    }
  }

  function loadInput(input) {
    const bytes = toBytes(input);
    if (bytes.length > maxData) {
      throw new Error(`input too large: ${bytes.length} > ${maxData}`);
    }
    heap.set(bytes, dataPtr);
    return bytes.length;
  }

  function readDigestHex() {
    return hex(new Uint8Array(memory.buffer, outPtr, CV_LEN));
  }

  function hash(input) {
    ensureNotBusy();
    const len = loadInput(input);
    wasm.blake3_hash(dataPtr, len, outPtr);
    return readDigestHex();
  }

  async function hashParallel(input, totalThreads = maxThreads) {
    ensureNotBusy();
    busy = true;

    try {
      const len = loadInput(input);

      totalThreads = Math.max(1, Math.min(maxThreads, totalThreads | 0));
      const bgWorkers = totalThreads - 1;

      const expected = signalSeen;

      const totalCvs = wasm.dispatch(
        ctrlPtr,
        dataPtr,
        len,
        outPtr,
        bgWorkers,
        minBlock,
      );

      if (totalCvs >= 2) {
        await waitForChange(ctrl, SIGNAL, expected);
        signalSeen = Atomics.load(ctrl, SIGNAL);
        wasm.merge_cv_tree(outPtr, totalCvs, outPtr);
      }

      return readDigestHex();
    } finally {
      busy = false;
    }
  }

  return {
    maxData,
    maxThreads,
    hash,
    hashParallel,
  };
}

export default init();
