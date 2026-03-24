self.onmessage = async ({ data: msg }) => {
    const { exports } = await WebAssembly.instantiate(
        msg.wasmModule, { env: { memory: msg.memory } },
    );
    if (exports.__stack_pointer)
        exports.__stack_pointer.value =
        msg.stacksBase + (msg.index + 1) * msg.stackSize;
    self.postMessage('ready');
    exports.worker_loop(msg.ctrlPtr, msg.index, msg.dataPtr, msg.cvPtr);
};
