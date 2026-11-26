export type ExtensionGenerationState = { isSendPress: boolean; isGroupGenerating: boolean };

// Read-only projection of this conversation's native submission/observations.
// Journal acknowledgement and UI locks are independent of worker activity.
export function extensionGenerationState(group: boolean, submitting: boolean, records: { requestId: string; seq: number; status: string; drained?: boolean }[]): ExtensionGenerationState {
  const latest = new Map<string, typeof records[number]>();
  for (const record of records) {
    const previous = latest.get(record.requestId);
    if (!previous || record.seq >= previous.seq) latest.set(record.requestId, record);
  }
  const active = submitting || [...latest.values()].some(record => !["done", "error", "failed", "cancelled", "unknown"].includes(record.status) || record.drained === false);
  return { isSendPress: !group && active, isGroupGenerating: group && active };
}

// Parent-only UI locks. Each frame can release only its own lock; closing a
// frame releases it without changing any native generation/admission state.
export function createExtensionSendButtons(changed: (disabled: boolean) => void) {
  const locks = new Map<AbortSignal, () => void>();
  let disposed = false;
  const release = (signal: AbortSignal) => {
    const listener = locks.get(signal);
    if (!listener) return;
    locks.delete(signal); signal.removeEventListener("abort", listener);
    changed(locks.size > 0);
  };
  return {
    setEnabled(enabled: boolean, signal: AbortSignal) {
      if (disposed || signal.aborted) throw Error("The chat controls or extension session were replaced or aborted.");
      if (enabled) { release(signal); return; }
      if (locks.has(signal)) return;
      const listener = () => release(signal);
      locks.set(signal, listener); signal.addEventListener("abort", listener, { once: true });
      changed(true);
    },
    isDisabled: () => locks.size > 0,
    dispose() {
      if (disposed) return;
      disposed = true;
      const disabled = locks.size > 0;
      for (const [signal, listener] of locks) signal.removeEventListener("abort", listener);
      locks.clear();
      if (disabled) changed(false);
    },
  };
}

// Parent-only lifecycle for printMessages. A successful read is not a successful
// render: React must acknowledge the exact ticket after committing its DOM.
export function createExtensionChatPrinter<T>(host: {
  read: (signal: AbortSignal) => Promise<T>;
  publish: (page: T, ticket: object) => void;
  scroll: () => void;
}) {
  type Pending = { ticket: object; controller: AbortController; finish: (error?: Error) => void; signal?: AbortSignal };
  let pending: Pending | undefined;
  let disposed = false;
  const cancel = (message = "The transcript view changed before printMessages completed.") => pending?.finish(Error(message));
  return {
    printMessages(signal?: AbortSignal): Promise<void> {
      if (disposed || signal?.aborted) return Promise.reject(Error("The chat renderer was replaced or aborted."));
      if (pending) return Promise.reject(Error("printMessages is already in progress."));
      return new Promise<void>((resolve, reject) => {
        const controller = new AbortController();
        const abort = () => request.finish(Error("The extension session was replaced or aborted."));
        const timer = setTimeout(() => request.finish(Error("printMessages timed out before the transcript was rendered.")), 25_000);
        const request: Pending = {
          ticket: {}, controller, signal,
          finish(error) {
            if (pending !== request) return;
            pending = undefined;
            clearTimeout(timer); signal?.removeEventListener("abort", abort);
            controller.abort();
            if (error) reject(error); else resolve();
          },
        };
        pending = request;
        signal?.addEventListener("abort", abort, { once: true });
        void (async () => {
          try {
            const page = await host.read(controller.signal);
            if (pending !== request || controller.signal.aborted) return;
            host.publish(page, request.ticket);
          } catch (cause) { request.finish(cause instanceof Error ? cause : Error("Unable to render the transcript.")); }
        })();
      });
    },
    committed(ticket: object) {
      const request = pending;
      if (!request || request.ticket !== ticket) return;
      if (disposed || request.signal?.aborted) { request.finish(Error("The chat renderer was replaced or aborted.")); return; }
      try { host.scroll(); request.finish(); }
      catch (cause) { request.finish(cause instanceof Error ? cause : Error("Unable to scroll the transcript.")); }
    },
    cancel,
    dispose() { disposed = true; cancel("The chat renderer was replaced or aborted."); },
  };
}
