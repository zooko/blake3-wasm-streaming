// Raw WASM worker — no wasm-bindgen, no imports.
// Receives a compiled WebAssembly.Module + shared Memory from the main thread.

let hashFn = null;

self.onmessage = async (e) => {
    const msg = e.data;
    try {
        if (msg.type === 'init') {
            const { wasmModule, memory, stackTop } = msg;

            // Build imports by introspecting the module
            const modImports = WebAssembly.Module.imports(wasmModule);
            const imports = {};
            for (const imp of modImports) {
                if (!imports[imp.module]) imports[imp.module] = {};
                if (imp.kind === 'memory') {
                    imports[imp.module][imp.name] = memory;
                } else if (imp.kind === 'function') {
                    imports[imp.module][imp.name] = () => {};
                } else if (imp.kind === 'table') {
                    imports[imp.module][imp.name] = new WebAssembly.Table({ initial: 128, element: 'anyfunc' });
                } else if (imp.kind === 'global') {
                    imports[imp.module][imp.name] = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
                }
            }

            const instance = await WebAssembly.instantiate(wasmModule, imports);
            const ex = instance.exports;

            // Each worker gets its own stack region for thread safety
            if (ex.__stack_pointer) {
                ex.__stack_pointer.value = stackTop;
            }

            hashFn = ex.hash_64k_parcel_to_cv_from_ptr;
            if (!hashFn) {
                throw new Error(
                    'hash_64k_parcel_to_cv_from_ptr not found. Exports: ' +
                        Object.keys(ex).filter(n => !n.startsWith('__')).join(', ')
                );
            }

            self.postMessage({ type: 'ready' });
            return;
        }

        if (msg.type === 'hash') {
            if (!hashFn) throw new Error('worker not initialized');
            const { taskId, jobs } = msg;
            for (const job of jobs) {
                hashFn(job.dataPtr, job.size, BigInt(job.offset), job.cvPtr);
            }
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
