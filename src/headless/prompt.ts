import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ApiError } from './contract.js';
import { readSettings } from './session.js';
import { buildProviderRequest, listExtensions } from './prompt-settings.js';
import { snapshotWorldBooks } from './world-info-runtime/snapshot.js';
import { publicConfiguration } from './redaction.js';

export type BuiltPrompt = Record<string, any> & {
    messages: Array<Record<string, any>>;
    providerRequest: Record<string, any>;
};

export { buildProviderRequest, listExtensions } from './prompt-settings.js';

let worker: any = null, sequence = 0, active: any = null, pendingBytes = 0;
const queue: any[] = [];
function settle(job: any, error: any, result: any = undefined) {
    clearTimeout(job.timeout);
    pendingBytes -= job.bytes;
    if (error) job.reject(error); else job.resolve(result);
}
function drain() {
    if (active || queue.length === 0) return;
    if (!worker) {
        let created;
        try {
            const workerFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompt-worker.js');
            created = new Worker(pathToFileURL(workerFile), { resourceLimits: { maxOldGenerationSizeMb: 256 }, execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')) });
        } catch {
            settle(queue.shift(), new ApiError(422, 'validation', 'Native evaluation worker could not start.'));
            queueMicrotask(drain);
            return;
        }
        worker = created;
        created.on('message', message => {
            if (created !== worker || message.id !== active?.id) return;
            const job = active; active = null; created.unref();
            settle(job, message.error ? new ApiError(message.error.status, message.error.code, message.error.message) : null, message.result);
            drain();
        });
        const failed = () => {
            if (created !== worker) return;
            worker = null;
            if (active) { const job = active; active = null; settle(job, new ApiError(422, 'validation', 'Native evaluation worker stopped.')); }
            drain();
        };
        created.on('error', failed); created.on('exit', failed); created.unref();
    }
    active = queue.shift();
    const job = active;
    job.timeout = setTimeout(() => {
        if (active !== job) return;
        const stopped = worker; worker = null; active = null;
        void stopped.terminate();
        settle(job, new ApiError(422, 'validation', 'Native text/prompt evaluation exceeded its time limit.'));
        drain();
    }, 10000);
    try { worker.ref(); worker.postMessage({ id: job.id, payload: job.payload }); } catch {
        active = null; worker.unref();
        settle(job, new ApiError(422, 'validation', 'Prompt preparation input cannot be transferred safely.'));
        drain();
    }
}
function execute(payload: any) {
    if (queue.length >= 32) throw new ApiError(429, 'validation', 'Native evaluation queue is full.');
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > 67_108_864) throw new ApiError(422, 'validation', 'Prompt preparation input exceeds its size limit.');
    if (pendingBytes + bytes > 67_108_864) throw new ApiError(429, 'validation', 'Native evaluation memory queue is full.');
    return new Promise((resolve, reject) => { pendingBytes += bytes; queue.push({ id: ++sequence, payload, bytes, resolve, reject }); drain(); });
}
export async function buildPrompt(session: any, character: any, chat: any, options: any) {
    if (session.settings.main_api !== 'openai') throw new ApiError(422, 'unsupported', `main_api "${session.settings.main_api}" is not supported.`);
    if (!['openai', 'custom'].includes(session.settings.oai_settings?.chat_completion_source ?? 'openai')) throw new ApiError(422, 'unsupported', 'This Chat Completion source is not supported.');
    const request = buildProviderRequest(session, [], options.overrides ?? {});
    const result: any = await execute({ session: evaluationSession(session, options.overrides), character, chat, options: { ...options, extensions: listExtensions(session), _books: snapshotWorldBooks(session, character, chat, options.characterId) } });
    return { ...result, providerRequest: { ...request, messages: result.messages } };
}
export function runNativeText(session: any, character: any, chat: any, options: any) {
    return execute({ operation: 'text', session: evaluationSession(session), character, chat, options: { ...options, extensions: options.extensions ?? listExtensions(session) } });
}
/** Evaluate display rows in one worker admission with an independent macro frame per row. */
export function runNativeDisplayBatch(session: any, chat: any, contexts: any, rows: any, options: any) {
    return execute({ operation: 'displayBatch', session: evaluationSession(session), chat, contexts, rows, options: { ...options, extensions: listExtensions(session) } });
}
function evaluationSession(session: any, overrides: Record<string, any> = {}) {
    const live = session.directories?.root && fs.existsSync(path.join(session.directories.root, 'settings.json')) ? readSettings(session.directories) : session.settings;
    const oai = session.settings.oai_settings ?? {};
    const safeOai = Object.fromEntries(['chat_completion_source', 'openai_model', 'custom_model', 'openai_max_context', 'openai_max_tokens', 'prompts', 'prompt_order', 'new_chat_prompt', 'new_example_chat_prompt', 'personality_format', 'scenario_format', 'use_sysprompt', 'preset_settings_openai', 'new_group_chat_prompt', 'wi_format', 'group_nudge_prompt', 'impersonation_prompt', 'continue_prefill', 'continue_nudge_prompt', 'assistant_prefill', 'send_if_empty', 'names_behavior', 'squash_system_messages', 'show_thoughts', 'tool_reasoning_mode', 'function_calling'].filter(key => key in oai).map(key => [key, oai[key]]));
    safeOai.extensions = { regex_scripts: oai.extensions?.regex_scripts ?? [] };
    const extensions = session.extensionSettings ?? {};
    const safeExtensions = Object.fromEntries(['regex', 'disabledExtensions', 'character_allowed_regex', 'preset_allowed_regex', 'note'].filter(key => key in extensions).map(key => [key, extensions[key]]));
    safeExtensions.variables = { global: live.extension_settings?.variables?.global ?? {} };
    const powerUser = publicConfiguration(session.settings.power_user ?? {});
    delete powerUser.tokenizer;
    delete powerUser.token_padding;
    const settings: Record<string, any> = { main_api: session.settings.main_api, max_context: session.settings.max_context, amount_gen: session.settings.amount_gen, oai_settings: safeOai, power_user: powerUser, world_info_settings: session.settings.world_info_settings, extension_settings: safeExtensions, tag_map: session.settings.tag_map };
    return { settings, extensionSettings: safeExtensions, userName: session.userName, directories: {} };
}
