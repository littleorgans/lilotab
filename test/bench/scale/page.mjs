// This function runs only in the disposable headless page. The runtime supplies the production overlay's port.
export function installFixture(iconStart, iconEnd) {
  const event = () => {
    const listeners = new Set();
    return {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
      emit(...args) {
        for (const listener of listeners) listener(...args);
      },
    };
  };
  const id = 'lilotab-scale-fixture';
  const onConnect = event();
  globalThis.chrome ??= {};
  globalThis.chrome.runtime = { id, onConnect, getURL: () => 'chrome-extension://' + id + '/' };

  let root, port, work, nextInput, ready;
  globalThis.scaleFixture = {
    configure(data) {
      work = data;
    },
    async open() {
      performance.clearMarks();
      nextInput = 0;
      const onMessage = event();
      const onDisconnect = event();
      const started = Promise.withResolvers();
      ready = started;
      port = {
        name: work.name,
        sender: { id },
        onMessage,
        onDisconnect,
        disconnect() {
          onDisconnect.emit();
        },
        postMessage(message) {
          if (message.t === 'ready') {
            ready.resolve();
            return;
          }
          const next = work.inputs[nextInput++];
          const input = message.input;
          if (
            message.t !== 'input' ||
            !next ||
            input.kind !== next.input.kind ||
            input.text !== next.input.text ||
            input.delta !== next.input.delta
          ) {
            ready.reject(new Error('The overlay sent unexpected input'));
            throw new Error('The overlay sent unexpected input');
          }
          queueMicrotask(() => {
            onMessage.emit(next.message);
          });
        },
      };
      onConnect.emit(port);
      // Observe the closed root from the fixture and leave the overlay's shadow mode and host code intact.
      const attachShadow = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (options) {
        root = attachShadow.call(this, options);
        return root;
      };
      try {
        onMessage.emit(work.start);
      } finally {
        Element.prototype.attachShadow = attachShadow;
      }
      await started.promise;
    },
    read(input) {
      const list = root.querySelector('ul.search');
      const frame = input < 0 ? work.start.start.frame : work.inputs[input].message.frame;
      const rowId = ({ window, row }) => 'row-' + window + '-' + row;
      const selected = rowId(frame.results[frame.highlight]);
      return {
        rows: list.childElementCount,
        elements: root.querySelectorAll('*').length,
        images: list.querySelectorAll('img.icon').length,
        matches:
          list.closest('.panel').classList.contains('shown') &&
          root.activeElement?.value === frame.query &&
          list.getAttribute('aria-activedescendant') === selected &&
          list.querySelector('[aria-selected="true"]')?.id === selected &&
          list.childElementCount === frame.results.length &&
          frame.results.every((ref, i) => list.children[i].id === rowId(ref)),
      };
    },
    async icons() {
      performance.mark(iconStart);
      port.onMessage.emit(work.icons);
      performance.mark(iconEnd);
      await Promise.all([...root.querySelectorAll('ul.search img.icon')].map((img) => img.decode()));
    },
    close() {
      port.disconnect();
      root = undefined;
      port = undefined;
    },
  };
}
