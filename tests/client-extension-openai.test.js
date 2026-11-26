import fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../client/lib/extension-runtime/openai.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } });
const exports = {}; new Function('exports', outputText)(exports);
// Exercise the actual serialization boundary, without compiler helper closures.
const install = new Function(`return (${exports.installExtensionOpenAI.toString()});`)();
const estimate = value => Math.ceil(value.length / 3.35);
function runtime(request = async () => ({ chat_completion_source: 'custom', custom_model: 'test-model', show_thoughts: true })) {
    return install(globalThis, {
        unsupported: name => { throw Error(`Unsupported: ${name}`); }, request, countText: estimate,
        isDataURL: value => typeof value === 'string' && value.startsWith('data:'),
    })['/scripts/openai.js'];
}
const state = () => ({ reasoning: '', images: [], signature: null, toolSignatures: {} });

describe('upstream OpenAI extension interfaces', () => {
    test('uses explicit model settings or a read-only initialized snapshot, never exposing connection settings', async () => {
        const module = runtime();
        expect(() => module.getChatCompletionModel()).toThrow('not loaded');
        expect(() => module.oai_settings.chat_completion_source).toThrow('not loaded');
        expect(module.getChatCompletionModel({ chat_completion_source: 'openrouter', openrouter_model: 'OR_Website' })).toBeNull();
        expect(module.getChatCompletionModel({ chat_completion_source: 'makersuite', google_model: 'gemini-test' })).toBe('gemini-test');
        expect(module.getChatCompletionModel({ chat_completion_source: '__proto__' })).toBe('');
        expect(module.getChatCompletionModel({ chat_completion_source: 'unknown' })).toBe('');
        for (const value of Object.values(module.chat_completion_sources)) {
            const field = value === 'makersuite' ? 'google_model' : `${value}_model`;
            expect(module.getChatCompletionModel({ chat_completion_source: value, [field]: `${value}-model` })).toBe(`${value}-model`);
        }
        expect(Object.keys(module)).not.toContain('initialize');
        await module.initialize();
        expect(module.getChatCompletionModel()).toBe('test-model');
        expect(module.oai_settings.custom_model).toBe('test-model');
        expect(module.oai_settings.show_thoughts).toBe(true);
        for (const key of ['custom_url', 'api_key', 'proxy_password', 'custom_include_headers', 'extensions']) expect(() => module.oai_settings[key]).toThrow('Unsupported');
        expect(() => { module.oai_settings.custom_model = 'changed'; }).toThrow('write');
        expect(() => Object.defineProperty(module.oai_settings, 'custom_model', { value: 'changed' })).toThrow('define');
        expect(() => { delete module.oai_settings.custom_model; }).toThrow('delete');
        expect(() => Object.setPrototypeOf(module.oai_settings, {})).toThrow('prototype');
        expect(module.getChatCompletionModel()).toBe('test-model');
        const failed = runtime(async () => { throw Error('Unavailable'); });
        await expect(failed.initialize()).rejects.toThrow('Unavailable');
        expect(() => failed.getChatCompletionModel()).toThrow('not loaded');
    });
    test('shares read-only numeric token limits without guessing missing settings', async () => {
        const module = runtime(async () => ({ chat_completion_source: 'custom', openai_max_context: 32768, openai_max_tokens: 1024 }));
        expect(() => module.oai_settings.openai_max_context).toThrow('not loaded');
        await module.initialize();
        expect(module.oai_settings.openai_max_context).toBe(32768);
        expect(module.oai_settings.openai_max_tokens).toBe(1024);
        for (const key of ['openai_max_context', 'openai_max_tokens']) {
            expect(() => { module.oai_settings[key] = 1; }).toThrow('write');
            expect(() => Object.defineProperty(module.oai_settings, key, { value: 1 })).toThrow('define');
            expect(() => { delete module.oai_settings[key]; }).toThrow('delete');
        }
        const missing = runtime(); await missing.initialize();
        expect(missing.oai_settings.openai_max_context).toBeUndefined();
        expect(missing.oai_settings.openai_max_tokens).toBeUndefined();
    });
    test('creates text messages with approximate tokens, preserves names, content arrays and tool metadata', async () => {
        const { Message, MessageCollection } = runtime();
        const message = await Message.createAsync('', 'Hello', 'first');
        expect(message.role).toBe('system');
        expect(message.tokens).toBe(estimate(JSON.stringify({ role: 'system', content: 'Hello' })));
        await message.setName('Ada');
        expect(message.tokens).toBe(estimate(JSON.stringify({ role: 'system', content: 'Hello', name: 'Ada' })));
        expect(message.ensureContentIsArray()).toEqual([{ type: 'text', text: 'Hello' }]);
        const array = message.content; expect(message.ensureContentIsArray()).toBe(array);
        expect((await Message.createAsync('assistant', '', 'empty')).getTokens()).toBe(0);
        const tool = await Message.fromPromptAsync({ role: 'tool', content: 'result', identifier: 'call-1' });
        tool.signature = 'signature';
        const assistant = await Message.createAsync('assistant', '', 'proposal');
        await assistant.setToolCalls([{ id: 'call-1', name: 'lookup', parameters: '{"q":"x"}', signature: 'signed', reasoning: 'reason' }], true, true);
        expect(assistant.tool_calls).toEqual([{ id: 'call-1', type: 'function', function: { arguments: '{"q":"x"}', name: 'lookup' }, signature: 'signed' }]);
        const chat = new MessageCollection('tools', assistant, tool).getChat();
        expect(chat[0]).toMatchObject({ role: 'assistant', content: '', reasoning: 'reason', tool_calls: assistant.tool_calls });
        expect(chat[1]).toEqual({ role: 'tool', content: 'result', tool_call_id: 'call-1', signature: 'signature' });
        await assistant.setToolCalls([], false);
        expect(assistant.reasoning).toBeNull();
        expect(assistant.tool_calls).toEqual([]);
    });
    test('preserves collection identity, shallow chat projections and explicit recursive flattening', async () => {
        const { Message, MessageCollection } = runtime();
        const message = await Message.createAsync('user', 'Hello', 'user');
        const nested = new MessageCollection('nested', message);
        const collection = new MessageCollection('root', nested);
        expect(collection.getChat()).toEqual([]);
        expect(collection.flatten()).toEqual([message]);
        expect(collection.getItemByIdentifier('nested')).toBe(nested);
        expect(collection.hasItemWithIdentifier('user')).toBe(false);
        expect(collection.getTokens()).toBe(message.getTokens());
        expect(collection.getCollection()).toBe(collection.collection);
        expect(() => new MessageCollection('invalid', { role: 'user', content: 'Hello' })).toThrow('Only Message');
        const foreign = new (runtime().Message)('user', 'Hello', 'foreign');
        expect(() => new MessageCollection('invalid', foreign)).toThrow('Only Message');
    });
    test('tracks local budgets, reservations, positional collections, insertion, removal and original error names', async () => {
        const { ChatCompletion, Message, MessageCollection, IdentifierNotFoundError } = runtime();
        const completion = new ChatCompletion(); completion.setTokenBudget(100, 10);
        completion.reserveBudget(3); expect(completion.tokenBudget).toBe(87);
        const first = await Message.createAsync('user', 'first', 'first');
        const collection = new MessageCollection('history', first);
        expect(completion.add(collection, 2)).toBe(completion);
        expect(completion.has('history')).toBe(true);
        expect(completion.findMessageIndex('history')).toBe(2);
        expect(completion.tokenBudget).toBe(87 - first.tokens);
        const second = await Message.createAsync('assistant', 'second', 'second');
        completion.insertAtStart(second, 'history');
        expect(completion.getChat().map(message => message.content)).toEqual(['second', 'first']);
        completion.removeLastFrom('history');
        expect(completion.getTotalTokenCount()).toBe(second.tokens);
        expect(completion.tokenBudget).toBe(87 - second.tokens);
        completion.reserveBudget(collection); completion.freeBudget(collection);
        expect(completion.tokenBudget).toBe(87 - second.tokens);
        expect(completion.canAffordAll([first, second])).toBe(true);
        expect(() => completion.findMessageIndex('missing')).toThrow(IdentifierNotFoundError);
        expect(() => completion.insert({}, 'history')).toThrow('instance of Message');
        expect(() => completion.add(first)).toThrow('instance of MessageCollection');
        completion.setTokenBudget(0, 0);
        expect(() => completion.add(new MessageCollection('too-much', first))).toThrow('Token budged exceeded');
        try { completion.checkTokenBudget(first, 'first'); } catch (error) { expect(error.name).toBe('TokenBudgetExceeded'); }
        const overrides = ['main']; completion.setOverriddenPrompts(overrides); expect(completion.getOverriddenPrompts()).toBe(overrides);
        completion.enableLogging(); expect(completion.loggingEnabled).toBe(true); completion.disableLogging(); expect(completion.loggingEnabled).toBe(false);
    });
    test('squashes eligible system messages while preserving reserved boundaries, names and upstream budget behavior', async () => {
        const { ChatCompletion, Message, MessageCollection } = runtime();
        const completion = new ChatCompletion(); completion.setTokenBudget(1000, 10);
        const messages = [];
        for (const [identifier, content] of [['a', 'first'], ['b', 'second'], ['empty', ''], ['newChat', 'boundary'], ['c', 'after'], ['d', 'named']]) messages.push(await Message.createAsync('system', content, identifier));
        await messages[5].setName('named');
        completion.add(new MessageCollection('history', new MessageCollection('nested', ...messages)));
        const budget = completion.tokenBudget;
        await completion.squashSystemMessages();
        expect(completion.getChat().map(message => message.content)).toEqual(['first\nsecond', 'boundary', 'after', 'named']);
        expect(messages[0].tokens).toBe(estimate(JSON.stringify({ role: 'system', content: 'first\nsecond' })));
        expect(completion.tokenBudget).toBe(budget);
    });
    test('TokenHandler invokes supplied counters and keeps upstream count bookkeeping', async () => {
        const { TokenHandler } = runtime(); const calls = [];
        const handler = new TokenHandler(async (...args) => { calls.push(args); return 5; });
        expect(await handler.countAsync({ content: 'x' }, true, 'prompt')).toBe(5);
        expect(calls).toEqual([[{ content: 'x' }, true]]);
        handler.uncount(2, 'prompt'); expect(handler.getTotal()).toBe(3);
        expect(handler.getTokensForIdentifier('missing')).toBe(0);
        const counts = { custom: 8 }; handler.setCounts(counts); expect(handler.getCounts()).toBe(counts);
        handler.resetCounts(); expect(counts).toEqual({ custom: 0 });
        await handler.countAsync({ content: 'unclassified' });
        expect(Number.isNaN(handler.getCounts().undefined)).toBe(true); expect(handler.getTotal()).toBe(0);
    });
    test('extracts stream text and accumulates reasoning with provider-specific precedence and explicit switches', async () => {
        const module = runtime(); const current = state();
        expect(() => module.getStreamingReply({ choices: [] }, current)).toThrow('not loaded');
        await module.initialize();
        expect(module.getStreamingReply({ choices: [{ delta: { content: 'text', reasoning: 'fallback', reasoning_content: 'preferred' } }] }, current)).toBe('text');
        expect(current.reasoning).toBe('preferred');
        expect(module.getStreamingReply({ choices: [{ delta: { content: 'hidden', reasoning_content: 'ignored' } }] }, current, { overrideShowThoughts: false })).toBe('hidden');
        expect(current.reasoning).toBe('preferred');
        const explicit = runtime();
        expect(explicit.getStreamingReply({ delta: { thinking: 'thought', text: 'Claude text' } }, current, { chatCompletionSource: 'claude', overrideShowThoughts: true })).toBe('Claude text');
        expect(current.reasoning).toBe('preferredthought');
        expect(explicit.getStreamingReply({ delta: { message: { tool_plan: 'plan' } } }, current, { chatCompletionSource: 'cohere', overrideShowThoughts: false })).toBe('plan');
        expect(explicit.getStreamingReply({ choices: [{ delta: { content: [{ text: 'a', thinking: [{ text: 'mistral thought' }] }, { text: 'b' }] } }] }, current, { chatCompletionSource: 'mistralai', overrideShowThoughts: true })).toBe('ab');
        expect(current.reasoning).toBe('preferredthoughtmistral thought');
    });
    test('retains streaming inline data and thought signatures as data without fetching remote media or executing tools', () => {
        const module = runtime(); const current = state();
        const openrouter = { choices: [{ delta: { images: [{ type: 'image_url', image_url: { url: 'https://private.invalid' } }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }], reasoning: 'router thought', reasoning_content: 'unused', content: 'reply', reasoning_details: [{ type: 'reasoning.encrypted', id: 'call_1', data: 'tool-signature' }, { type: 'reasoning.encrypted', id: 'thinking-1', data: 'signature' }] } }] };
        expect(module.getStreamingReply(openrouter, current, { chatCompletionSource: 'openrouter', overrideShowThoughts: true })).toBe('reply');
        expect(current).toEqual({ reasoning: 'router thought', images: ['data:image/png;base64,YQ=='], signature: 'signature', toolSignatures: { call_1: 'tool-signature', 'thinking-1': 'signature' } });
        const gemini = { candidates: [{ content: { parts: [{ thought: true, text: 'Gemini thought' }, { text: 'first', thoughtSignature: 'gemini-signature' }, { text: 'second' }, { inlineData: { mimeType: 'image/png', data: 'Yg==' } }] } }] };
        expect(module.getStreamingReply(gemini, current, { chatCompletionSource: 'makersuite', overrideShowThoughts: true })).toBe('first');
        expect(current.reasoning).toBe('router thoughtGemini thought');
        expect(current.images).toEqual(['data:image/png;base64,YQ==', 'data:image/png;base64,Yg==']);
        expect(current.signature).toBe('gemini-signature');
    });
    test('does not expose dispatch, live prompts, proxy secrets, media mutation or provider settings writes', async () => {
        const module = runtime();
        for (const name of ['isImageInliningSupported', 'isVideoInliningSupported', 'isAudioInliningSupported']) expect(module[name]()).toBe(false);
        for (const name of ['prepareOpenAIMessages', 'sendOpenAIRequest']) await expect(module[name]()).rejects.toThrow('Unsupported');
        for (const name of ['setOpenAIMessages', 'setOpenAIMessageExamples', 'setupChatCompletionPromptManager', 'loadOpenAISettings', 'tryParseStreamingError']) expect(() => module[name]()).toThrow('Unsupported');
        expect(() => module.promptManager.render()).toThrow('promptManager.render');
        expect(() => module.proxies.find).toThrow('private');
        const message = await module.Message.createAsync('user', 'unchanged', 'id');
        const tokens = message.tokens;
        for (const name of ['addImage', 'addVideo', 'addAudio', 'compressImage', 'getImageTokenCost']) await expect(message[name]('https://private.invalid')).rejects.toThrow('Unsupported');
        expect(message.content).toBe('unchanged'); expect(message.tokens).toBe(tokens);
        expect(module.getPromptPosition(2)).toBe('start'); expect(module.getPromptPosition(0)).toBe('end'); expect(module.getPromptPosition(1)).toBe(false);
        expect([0, 1, 2, 9].map(module.getPromptRole)).toEqual(['system', 'user', 'assistant', 'system']);
    });
});
