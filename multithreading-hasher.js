const WASM_URL = new URL(
  './target/wasm32-unknown-unknown/release/blake3_wasm_streaming.wasm',
  import.meta.url,
);

const WORKER_URL = new URL('./hash-worker.js', import.meta.url);

const PAGE = 65536;
const CV_LEN = 32;
const AUTO_THREAD_CAP = 4; // iPhone-targeted total-lane cap

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

function ceilDiv(n, d) {
  return Math.floor((n + d - 1) / d);
}

// Estimate how many subtree CVs we'd produce at the chosen minimum slice size.
function estimateCvCountForLen(len, minSlice) {
  return ceilDiv(len, minSlice);
}

function chooseTotalThreadsForCvCount(cvCount, maxThreads) {
  const cap = Math.min(maxThreads, AUTO_THREAD_CAP);

  if (cvCount <= 1) return 1;
  if (cvCount <= 4) return Math.min(cap, 2);
  if (cvCount === 5) return Math.min(cap, 3);
  return cap;
}

function chooseAutoTotalThreads(len, minSlice, maxThreads) {
  const cvCount = estimateCvCountForLen(len, minSlice);
  return chooseTotalThreadsForCvCount(cvCount, maxThreads);
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

  // Enforce the iPhone-tuned 8 KiB floor here, even if Rust still exports 4 KiB.
  const wasmMinSlice = wasm.config_min_slice();
  const minSlice = Math.max(wasmMinSlice, 8 * 1024);

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

  // Default behavior is now AUTO, not "always use maxThreads".
  // You can still pass an explicit totalThreads override.
  async function hashParallel(input, totalThreads = undefined) {
    ensureNotBusy();
    busy = true;

    try {
      const len = loadInput(input);

      const autoThreads = chooseAutoTotalThreads(len, minSlice, maxThreads);
      const threads =
        totalThreads == null
          ? autoThreads
          : Math.max(1, Math.min(maxThreads, totalThreads | 0));

      const bgWorkers = threads - 1;

      // Fast path: avoid dispatch/wait/merge when auto policy chooses 1 lane.
      if (threads === 1) {
        wasm.blake3_hash(dataPtr, len, outPtr);
        return readDigestHex();
      }

      const expected = signalSeen;

      const totalCvs = wasm.dispatch(
        ctrlPtr,
        dataPtr,
        len,
        outPtr,
        bgWorkers,
        minSlice,
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
    minSlice,

    // Handy introspection helpers for benchmarking/debugging.
    estimateCvCount(input) {
      const len = typeof input === 'number' ? input : toBytes(input).length;
      return estimateCvCountForLen(len, minSlice);
    },

    chooseTotalThreads(input) {
      const len = typeof input === 'number' ? input : toBytes(input).length;
      return chooseAutoTotalThreads(len, minSlice, maxThreads);
    },

    hash,
    hashParallel,
  };
}

export default init();
