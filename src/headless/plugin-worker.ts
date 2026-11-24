import { parentPort, workerData } from 'node:worker_threads';
const workerPort = parentPort!;

import { createPluginContext } from './plugin-context.js';

/**
 * Runs one trusted headless extension hook inside an isolated worker.
 * The worker receives only structured-cloneable data and never receives the
 * Express request, user directories, session cookies or native credential
 * handles. A bounded `SillyTavern.getContext()` compatibility shim is built
 * locally so extensions written against the ST global API can execute.
 */
async function run() {
    const { entry, hook, context: plainContext } = workerData;
    const { context, effects } = createPluginContext(plainContext);
    const module = await import(entry);
    const handler = module?.[hook];
    let returned = null;
    if (typeof handler === 'function') {
        returned = await handler(context);
    }
    workerPort.postMessage({
        ok: true,
        messages: context.messages,
        prompt: typeof context.prompt === 'string' ? context.prompt : null,
        generationText: typeof context.generation?.text === 'string' ? context.generation.text : null,
        returnedText: typeof returned === 'string' ? returned : null,
        effects,
    });
}

run().catch(error => {
    workerPort.postMessage({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        messages: null,
        effects: null,
    });
});
