import crypto from 'node:crypto';
import { ApiError, requireObject } from './contract.js';
import { emit, fail, persistGeneration, shouldStopGeneration } from './generation-store.js';

// ToolManager.RECURSE_LIMIT in public/scripts/tool-calling.js.
export const MAX_CLIENT_TOOL_ROUNDS = 5;
const MAX_TOOL_BYTES = 262_144;
const MAX_RESULT_BYTES = 1_048_576;
const activeBatches = new WeakMap();
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A supplied catalog describes callable functions. Each invocation needs its own claim. */
export function validateClientTools(value) {
    if (!Array.isArray(value) || value.length > 32 || Buffer.byteLength(JSON.stringify(value)) > MAX_TOOL_BYTES) {
        throw new ApiError(400, 'validation', 'tools must contain at most 32 function definitions within 256 KiB.');
    }
    const names = new Set();
    for (const tool of value) {
        const definition = tool?.function;
        if (tool?.type !== 'function' || !definition || !/^[a-zA-Z0-9_-]{1,64}$/.test(definition.name ?? '') || names.has(definition.name)
            || (definition.description !== undefined && typeof definition.description !== 'string')
            || !definition.parameters || typeof definition.parameters !== 'object' || Array.isArray(definition.parameters)) {
            throw new ApiError(400, 'validation', 'Each tool needs a unique function name, optional text description and parameter schema object.');
        }
        names.add(definition.name);
    }
    return structuredClone(value);
}

export function assertClientToolsProfile(session, input) {
    if (!input.tools?.length) return;
    if (!['normal', 'regenerate'].includes(input.type) || session.settings.main_api !== 'openai'
        || session.settings.oai_settings?.function_calling !== true) {
        throw new ApiError(422, 'unsupported', 'Client tools require enabled Chat Completion function calling and normal or regenerate generation.');
    }
}

function publishBatch(record, batch) {
    const previous = record.toolBatches ?? [];
    const next = previous.some(item => item.id === batch.id)
        ? previous.map(item => item.id === batch.id ? batch : item) : [...previous, batch];
    record.toolBatches = next;
    try {
        if (record.directories) persistGeneration(record.directories, record);
    } catch (error) {
        record.toolBatches = previous;
        fail(record, 'unknown', 'The tool execution journal could not be synchronized. Inspect this request before taking another action.');
        record.controller.abort();
        throw error;
    }
    emit(record, 'tool_batch', batch);
}

function batchFor(record, batchId, input) {
    requireObject(input, 'tool batch action');
    const batch = record.toolBatches?.find(item => item.id === batchId);
    if (!batch) throw new ApiError(404, 'not_found', 'Tool batch not found.');
    if (input.expectedRevision !== batch.revision) throw new ApiError(409, 'conflict', 'Tool proposal changed. Inspect the complete batch before acting.');
    return batch;
}

function liveBatch(record, batch) {
    const active = activeBatches.get(record);
    if (shouldStopGeneration(record) || !record.workerActive || !active || active.id !== batch.id) {
        throw new ApiError(409, 'conflict', 'This tool batch has no live generation worker. Inspect its outcome before taking another action.');
    }
    return active;
}

function executionId(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw new ApiError(400, 'validation', 'A caller-owned executionId is required.');
    return value;
}

/** Claims the exact inspected batch before the native executor sends any tool request. */
export function claimClientToolBatch(record, batchId, input) {
    const batch = batchFor(record, batchId, input);
    const id = executionId(input.executionId);
    if (batch.executionId === id && ['executing', 'completed'].includes(batch.status)) return { batch, idempotent: true, dispatchAuthorized: false };
    liveBatch(record, batch);
    if (batch.status !== 'awaiting_approval') throw new ApiError(409, 'conflict', 'This tool batch was already claimed or declined.');
    if (record.toolBatches.some(item => item.executionId === id)) throw new ApiError(409, 'conflict', 'executionId belongs to a different tool batch.');
    const claimed = { ...batch, executionId: id, status: 'executing' };
    publishBatch(record, claimed);
    return { batch: claimed, idempotent: false, dispatchAuthorized: true };
}

export function declineClientToolBatch(record, batchId, input) {
    const batch = batchFor(record, batchId, input);
    if (batch.status === 'declined') return { batch, idempotent: true };
    const active = liveBatch(record, batch);
    if (batch.status !== 'awaiting_approval') throw new ApiError(409, 'conflict', 'An executing batch requires cancellation and outcome inspection.');
    const declined = { ...batch, status: 'declined' };
    publishBatch(record, declined);
    active.reject(new ApiError(422, 'confirmation_required', 'Tool execution was declined. Inspect the retained generation before submitting another request.'));
    return { batch: declined, idempotent: false };
}

/** Accepts one complete ordered result set. Duplicate receipts never resume a worker twice. */
export function submitClientToolResults(record, batchId, input) {
    const batch = batchFor(record, batchId, input);
    if (executionId(input.executionId) !== batch.executionId) throw new ApiError(409, 'conflict', 'Tool execution identity changed.');
    const results = input.results;
    if (!Array.isArray(results) || results.length !== batch.calls.length || Buffer.byteLength(JSON.stringify(results)) > MAX_RESULT_BYTES
        || results.some((item, index) => !item || item.id !== batch.calls[index].id || typeof item.result !== 'string' || typeof item.isError !== 'boolean')) {
        throw new ApiError(400, 'validation', 'A bounded ordered result and explicit isError value are required for every claimed call.');
    }
    const fingerprint = digest(results);
    if (batch.status === 'completed' && batch.resultFingerprint === fingerprint) return { batch, idempotent: true };
    const active = liveBatch(record, batch);
    if (batch.status !== 'executing') throw new ApiError(409, 'conflict', 'Tool results require an outstanding claimed batch.');
    const completed = { ...batch, status: 'completed', resultFingerprint: fingerprint,
        results: results.map(item => ({ id: item.id, result: active.protect(item.result), isError: item.isError })) };
    publishBatch(record, completed);
    active.resolve(completed.results);
    return { batch: completed, idempotent: false };
}

async function awaitClientToolResults(record, calls, tools, protect) {
    if (shouldStopGeneration(record)) throw new ApiError(409, 'conflict', 'Generation stopped before tool approval.');
    const batch = { id: crypto.randomUUID(), revision: digest({ requestId: record.requestId, calls, tools }),
        status: 'awaiting_approval', calls: calls.map(call => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })) };
    let resolve, reject;
    const pending = new Promise((done, failed) => { resolve = done; reject = failed; });
    pending.catch(() => {});
    const active = { id: batch.id, protect, resolve, reject };
    activeBatches.set(record, active);
    const abort = () => reject(new ApiError(409, 'unknown', 'Tool approval or execution was interrupted. Inspect the retained outcome.'));
    record.controller.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => reject(new ApiError(408, 'unknown', 'Tool approval or execution timed out. Inspect the retained outcome before trying another request.')), 300_000);
    timeout.unref?.();
    try {
        publishBatch(record, batch);
        if (record.controller.signal.aborted) abort();
        return await pending;
    } finally {
        clearTimeout(timeout);
        record.controller.signal.removeEventListener('abort', abort);
        if (activeBatches.get(record) === active) activeBatches.delete(record);
    }
}

/** Runs a bounded provider/tool-result conversation under the original admitted request. */
export async function runCompletionWithClientTools(request, providerRequest, record, session, tools) {
    const { runSessionCompletion } = await import('./provider.js');
    if (tools.length) record.clientTools = true;
    let next = providerRequest;
    const toolRows = [];
    for (let round = 0; round <= MAX_CLIENT_TOOL_ROUNDS; round++) {
        const result = await runSessionCompletion(request, next, record, session, tools);
        if (shouldStopGeneration(record) || !result.toolCalls?.length) return { ...result, toolRows };
        if (round === MAX_CLIENT_TOOL_ROUNDS) throw new ApiError(422, 'unsupported', 'The source tool recursion limit was reached. Inspect the retained calls and results.');
        const results = await awaitClientToolResults(record, result.toolCalls, tools, result.protectToolResult);
        if (shouldStopGeneration(record)) return { ...result, toolRows };
        const invocations = results.map((item, index) => ({ id: item.id, name: result.toolCalls[index].function.name,
            displayName: result.toolCalls[index].function.name, parameters: result.toolCalls[index].function.arguments,
            result: item.result, error: item.isError, reasoning: result.reasoning }));
        toolRows.push({ name: 'System', is_system: true, is_user: false,
            mes: invocations.map(item => `${item.name}\n${item.result}`).join('\n\n'),
            extra: { isSmallSys: true, tool_invocations: invocations, api: 'openai', model: next.model } });
        next = { ...next, messages: [...next.messages,
            { role: 'assistant', content: result.text || null, tool_calls: result.toolCalls },
            ...results.map(item => ({ role: 'tool', tool_call_id: item.id, content: item.result }))] };
    }
}
