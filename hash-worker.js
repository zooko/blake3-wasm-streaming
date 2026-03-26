self.onmessage = async e => {
  const { wasmModule, memory, index, ctrlPtr, dataPtr, cvPtr, stackPtr } = e.data;

  const { exports } = await WebAssembly.instantiate(wasmModule, {
    env: { memory },
  });

  exports.__stack_pointer.value = stackPtr;
  exports.worker_loop(ctrlPtr, index, dataPtr, cvPtr);
};
