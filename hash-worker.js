const GEN = 0, CHUNK = 1, ACTIVE = 2, DONE = 3, SIGNAL = 4;

self.onmessage = async ({ data: msg }) => {
    const { exports } = await WebAssembly.instantiate(
        msg.wasmModule, { env: { memory: msg.memory } },
    );
    if (exports.__stack_pointer)
        exports.__stack_pointer.value =
        msg.stacksBase + (msg.index + 1) * msg.stackSize;

    const ctrl = new Int32Array(msg.ctrl);
    const { index, dataPtr, cvPtr } = msg;

    self.postMessage('ready');

    let lastGen = 0;
    for (;;) {
        Atomics.wait(ctrl, GEN, lastGen);
        const gen = Atomics.load(ctrl, GEN);
        if (gen < 0) break;
        lastGen = gen;

        const active = Atomics.load(ctrl, ACTIVE);
        if (index >= active) continue;

        const chunk = Atomics.load(ctrl, CHUNK);
        exports.blake3_hash(
            dataPtr + index * chunk, chunk,
            cvPtr + index * 32,
        );

        if (Atomics.add(ctrl, DONE, 1) === active - 1) {
            Atomics.store(ctrl, SIGNAL, gen);
            Atomics.notify(ctrl, SIGNAL, 1);
        }
    }
};
