import { parentPort } from 'node:worker_threads';
const workerPort = parentPort!;
import path from 'node:path';
import { setConfigFilePath } from '../util.js';
import { serverDirectory } from '../server-directory.js';
setConfigFilePath(path.join(serverDirectory, 'default/config.yaml'));
const { buildPromptInline } = await import('./prompt-core.js');
const { evaluateNativeText } = await import('./text-core.js');
// Do not forward source evaluator console output to host logs.
console.log = console.info = console.debug = console.warn = console.error = () => {};
workerPort.on('message', async ({ id, payload }) => {
    try {
        const result = payload.operation === 'displayBatch' ? payload.rows.map((row: any) => {
            const context = payload.contexts[row.contextIndex];
            return evaluateNativeText(payload.session, context.character, payload.chat, { ...payload.options, ...context.options, messages: [row.message] });
        }) : payload.operation === 'text'
            ? evaluateNativeText(payload.session, payload.character, payload.chat, payload.options)
            : await buildPromptInline(payload.session, payload.character, payload.chat, payload.options);
        if (Buffer.byteLength(JSON.stringify(result)) > 33_554_432) throw new Error('Prompt result exceeds its size limit.');
        workerPort.postMessage({ id, result });
    } catch (error: any) {
        workerPort.postMessage({ id, error: { status: Number(error.status) || 422, code: error.code ?? 'validation', message: error.status ? error.message : 'Native text/prompt evaluation failed. Inspect the selected scripts and configuration.' } });
    }
});
