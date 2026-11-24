import { parentPort, workerData } from 'node:worker_threads';
const workerPort = parentPort!;
import { createVirtualDOM } from './virtual-dom.js';

async function run() {
    const dom = createVirtualDOM(workerData.html);
    globalThis.window = dom.window;
    globalThis.document = dom.document;
    (globalThis as any).$ = dom.$;
    (globalThis as any).jQuery = dom.$;
    const module = await import(workerData.entry);
    const init = module.init ?? module.default;
    if (typeof init !== 'function') throw new Error('Virtual DOM extension must export init(host).');
    await init({ window: dom.window, document: dom.document, $: dom.$, emit: () => dom.emit(), diagnostics: dom.diagnostics });
    const output = dom.emit();
    workerPort.postMessage({ ok: true, output: { ...output, diagnostics: dom.diagnostics } });
}

run().catch(error => workerPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }));
