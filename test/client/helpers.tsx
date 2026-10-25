import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

export function createTestRoot() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    container,
    render: async (node: ReactNode) => {
      await act(async () => root.render(node));
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
    button: (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (item) => item.textContent === label,
      );
      if (!button) throw new Error(`Button not found: ${label}`);
      return button;
    },
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
