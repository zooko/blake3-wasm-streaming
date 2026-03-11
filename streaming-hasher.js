import wasmInit, * as wasm from './pkg/blake3_wasm_streaming.js';

const CHUNK_LEN = 1024;
const DEFAULT_LEAF_SIZE = 1024 * 1024; // 1 MiB
const WORKER_INIT_TIMEOUT = 10000;
const HASH_TASK_TIMEOUT = 30000;

function maxSubtreeLen(offset) {
  if (offset === 0) return Infinity;

  const chunkIndex = offset / CHUNK_LEN;
  const trailingZeros = Math.log2(chunkIndex & -chunkIndex);
  return (2 ** trailingZeros) * CHUNK_LEN;
}

// JS equivalent of BLAKE3's left_subtree_len(content_len).
function leftSubtreeLen(size) {
  if (size <= CHUNK_LEN) {
    throw new Error('leftSubtreeLen requires size > CHUNK_LEN');
  }

  const fullChunks = Math.floor((size - 1) / CHUNK_LEN);
  const leftChunks = 2 ** Math.floor(Math.log2(fullChunks));
  return leftChunks * CHUNK_LEN;
}

function totalInFlight(counts) {
  let total = 0;
  for (const n of counts) total += n;
  return total;
}

export class StreamingHasher {
  #numWorkers;
  #leafSize;
  #bufferBudget;
  #workers = [];
  #pendingTasks = new Map();
  #nextTaskId = 0;
  #initialized = false;
  #nextNodeId = 0;
  #nodeMap = new Map();
  #outLen = 32;

  constructor(options = {}) {
    if (typeof options === 'number') {
      options = { workerCount: options };
    }

    this.#numWorkers = options.workerCount ?? 3;
    this.#leafSize = options.chunkSize ?? DEFAULT_LEAF_SIZE;

    if (options.bufferDepth != null) {
      this.#bufferBudget = options.bufferDepth * this.#leafSize;
    } else {
      this.#bufferBudget = options.bufferBudget ?? 256 * 1024 * 1024;
    }
  }

  async init() {
    await wasmInit();
    this.#outLen = wasm.out_len();

    const readyPromises = [];

    for (let i = 0; i < this.#numWorkers; i++) {
      const worker = new Worker(
        new URL('./streaming-worker.js', import.meta.url),
        { type: 'module' }
      );

      const readyPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(
              `Worker ${i} init timed out after ${WORKER_INIT_TIMEOUT}ms`
            )
          );
        }, WORKER_INIT_TIMEOUT);

        worker.onmessage = (e) => {
          if (e.data.type === 'ready') {
            clearTimeout(timeout);
            worker.onmessage = (evt) => this.#handleWorkerMessage(i, evt);
            resolve();
          } else if (e.data.type === 'error') {
            clearTimeout(timeout);
            reject(new Error(e.data.error));
          }
        };

        worker.onerror = (err) => {
          clearTimeout(timeout);
          reject(err);
        };
      });

      worker.postMessage({ type: 'init' });
      this.#workers.push(worker);
      readyPromises.push(readyPromise);
    }

    await Promise.all(readyPromises);

    for (let i = 0; i < this.#numWorkers; i++) {
      this.#workers[i].onerror = (err) => {
        for (const [taskId, pending] of this.#pendingTasks) {
          if (pending.workerIndex === i) {
            pending.reject(new Error(`Worker ${i} error: ${err.message}`));
            this.#pendingTasks.delete(taskId);
          }
        }
      };
    }

    this.#initialized = true;
  }

  #handleWorkerMessage(workerIndex, e) {
    const { type, taskId, cv, error } = e.data;
    const pending = this.#pendingTasks.get(taskId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.#pendingTasks.delete(taskId);

    if (type === 'result') {
      pending.resolve(new Uint8Array(cv));
    } else if (type === 'error') {
      pending.reject(new Error(error));
    }
  }

  #hashWholeMessageBuffer(buffer) {
    return new Uint8Array(
      wasm.hash_whole_message_root_bytes(new Uint8Array(buffer))
    );
  }

  #mergePair(leftCV, rightCV, isRoot) {
    return isRoot
      ? new Uint8Array(wasm.root_hash_bytes(leftCV, rightCV))
      : new Uint8Array(wasm.parent_cv_bytes(leftCV, rightCV));
  }

  #buildTree(offset, size) {
    const id = this.#nextNodeId++;
    const maxSub = maxSubtreeLen(offset);

    if (size <= this.#leafSize && size <= maxSub) {
      const node = {
        id,
        type: 'leaf',
        offset,
        size,
        parentId: null,
      };
      this.#nodeMap.set(id, node);
      return node;
    }

    const leftLen = leftSubtreeLen(size);
    const left = this.#buildTree(offset, leftLen);
    const right = this.#buildTree(offset + leftLen, size - leftLen);

    const node = {
      id,
      type: 'node',
      offset,
      size,
      leftId: left.id,
      rightId: right.id,
      parentId: null,
    };

    left.parentId = id;
    right.parentId = id;

    this.#nodeMap.set(id, node);
    return node;
  }

  #collectLeaves(node) {
    if (node.type === 'leaf') return [node];

    const nodeData = this.#nodeMap.get(node.id) ?? node;
    if (nodeData.type === 'leaf') return [nodeData];

    const left = this.#nodeMap.get(nodeData.leftId);
    const right = this.#nodeMap.get(nodeData.rightId);

    return [...this.#collectLeaves(left), ...this.#collectLeaves(right)];
  }

  async hashFile(file, onProgress) {
    return this.hashFileStreaming(file, onProgress);
  }

  async hashFileStreaming(file, onProgress) {
    if (!this.#initialized) {
      throw new Error('StreamingHasher not initialized. Call init() first.');
    }

    const t0 = performance.now();
    const totalBytes = file.size;

    if (totalBytes <= this.#leafSize) {
      const buffer = await file.arrayBuffer();
      const hash = this.#hashWholeMessageBuffer(buffer);
      if (onProgress) {
        onProgress({
          bytesRead: totalBytes,
          totalBytes,
          bytesHashed: totalBytes,
        });
      }
      return { hash, timeMs: performance.now() - t0 };
    }

    this.#nextNodeId = 0;
    this.#nodeMap = new Map();

    const root = this.#buildTree(0, totalBytes);

    if (root.type === 'leaf') {
      const buffer = await file.arrayBuffer();
      const hash = this.#hashWholeMessageBuffer(buffer);
      if (onProgress) {
        onProgress({
          bytesRead: totalBytes,
          totalBytes,
          bytesHashed: totalBytes,
        });
      }
      return { hash, timeMs: performance.now() - t0 };
    }

    const leaves = this.#collectLeaves(root);

    const maxInFlight = Math.min(
      256,
      Math.max(1, Math.floor(this.#bufferBudget / this.#leafSize))
    );

    const cvMap = new Map();
    const workerInFlight = new Array(this.#numWorkers).fill(0);

    let slotResolve = null;
    let bytesRead = 0;
    let bytesHashed = 0;

    let resolveRoot;
    let rejectRoot;
    const rootPromise = new Promise((resolve, reject) => {
      resolveRoot = resolve;
      rejectRoot = reject;
    });

    const bubbleUp = (nodeId) => {
      const node = this.#nodeMap.get(nodeId);

      if (node.parentId === null) {
        resolveRoot(cvMap.get(nodeId));
        return;
      }

      const parent = this.#nodeMap.get(node.parentId);
      const leftCv = cvMap.get(parent.leftId);
      const rightCv = cvMap.get(parent.rightId);

      if (leftCv && rightCv) {
        const isRoot = parent.parentId === null;
        const merged = this.#mergePair(leftCv, rightCv, isRoot);
        cvMap.set(parent.id, merged);
        bubbleUp(parent.id);
      }
    };

    let currentLeafIdx = 0;
    let leafBuffer = new Uint8Array(leaves[0].size);
    let leafFilled = 0;

    const reader = file.stream().getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk =
          value instanceof Uint8Array ? value : new Uint8Array(value);
        let chunkOffset = 0;

        while (chunkOffset < chunk.length && currentLeafIdx < leaves.length) {
          const leaf = leaves[currentLeafIdx];
          const remaining = leaf.size - leafFilled;
          const toCopy = Math.min(remaining, chunk.length - chunkOffset);

          leafBuffer.set(
            chunk.subarray(chunkOffset, chunkOffset + toCopy),
            leafFilled
          );

          leafFilled += toCopy;
          chunkOffset += toCopy;

          if (leafFilled === leaf.size) {
            while (totalInFlight(workerInFlight) >= maxInFlight) {
              await new Promise((resolve) => {
                slotResolve = resolve;
              });
            }

            let workerIdx = 0;
            for (let w = 1; w < this.#numWorkers; w++) {
              if (workerInFlight[w] < workerInFlight[workerIdx]) {
                workerIdx = w;
              }
            }

            workerInFlight[workerIdx]++;

            const leafId = leaf.id;
            const nodeSize = leaf.size;
            const bufferToSend = leafBuffer.buffer;

            this.#dispatchBuffer(workerIdx, bufferToSend, leaf.offset)
              .then((cv) => {
                workerInFlight[workerIdx]--;
                if (slotResolve) {
                  slotResolve();
                  slotResolve = null;
                }

                bytesHashed += nodeSize;
                if (onProgress) {
                  onProgress({ bytesRead, totalBytes, bytesHashed });
                }

                cvMap.set(leafId, cv);
                bubbleUp(leafId);
              })
              .catch((err) => {
                rejectRoot(err);
              });

            currentLeafIdx++;

            if (currentLeafIdx < leaves.length) {
              leafBuffer = new Uint8Array(leaves[currentLeafIdx].size);
              leafFilled = 0;
            }
          }
        }

        bytesRead += chunk.length;
        if (onProgress) {
          onProgress({ bytesRead, totalBytes, bytesHashed });
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (currentLeafIdx !== leaves.length) {
      throw new Error('File stream ended before all planned leaves were filled.');
    }

    const finalHash = await rootPromise;
    return { hash: finalHash, timeMs: performance.now() - t0 };
  }

  #dispatchBuffer(workerIdx, buffer, inputOffset) {
    const taskId = this.#nextTaskId++;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingTasks.delete(taskId);
        reject(
          new Error(`Hash task ${taskId} timed out after ${HASH_TASK_TIMEOUT}ms`)
        );
      }, HASH_TASK_TIMEOUT);

      this.#pendingTasks.set(taskId, {
        workerIndex: workerIdx,
        resolve,
        reject,
        timeout,
      });

      this.#workers[workerIdx].postMessage(
        {
          type: 'hash',
          taskId,
          data: buffer,
          offset: inputOffset,
        },
        [buffer]
      );
    });
  }

  terminate() {
    for (const worker of this.#workers) {
      worker.terminate();
    }
    this.#workers = [];

    for (const [, { reject, timeout }] of this.#pendingTasks) {
      clearTimeout(timeout);
      reject(new Error('StreamingHasher terminated'));
    }

    this.#pendingTasks.clear();
    this.#initialized = false;
  }
}
