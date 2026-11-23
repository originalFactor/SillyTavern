import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from './contract.js';
import { serverDirectory } from '../server-directory.js';
import { isValidUrl } from '../util.js';
import { buildTextProviderRequest } from './text-provider.js';

/**
 * Builds a provider request from saved settings only.
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @param {Array<{role: string, content: string}>} messages Chat Completion messages
 * @returns {Record<string, any>} Provider request
 */
export function buildProviderRequest(session, messages, overrides = {}) {
    if (session.settings.main_api === 'textgenerationwebui') return buildTextProviderRequest(session, overrides);
    const oai = session.settings.oai_settings ?? {};
    const source = String(oai.chat_completion_source ?? 'openai');
    if (!['openai', 'custom', 'claude'].includes(source)) throw new ApiError(422, 'unsupported', 'This native Chat Completion provider format is not connected.');
    const model = overrides.model ?? (source === 'custom' ? oai.custom_model : source === 'claude' ? oai.claude_model : oai.openai_model);
    if (!model) {
        throw new ApiError(422, 'validation', 'No Chat Completion model is configured.');
    }
    const request = {
        chat_completion_source: source,
        model: String(model),
        messages,
        temperature: overrides.temperature ?? Number(oai.temp_openai ?? 1),
        max_tokens: overrides.maxTokens ?? Number(oai.openai_max_tokens ?? session.settings.amount_gen ?? 300),
        max_completion_tokens: overrides.maxTokens ?? Number(oai.openai_max_tokens ?? session.settings.amount_gen ?? 300),
        frequency_penalty: overrides.frequencyPenalty ?? Number(oai.freq_pen_openai ?? 0),
        presence_penalty: overrides.presencePenalty ?? Number(oai.pres_pen_openai ?? 0),
        top_p: overrides.topP ?? Number(oai.top_p_openai ?? 1),
        stream: true,
    };
    if (Array.isArray(overrides.stop) && overrides.stop.length > 0) request.stop = overrides.stop.slice(0, 4).map(String);
    if (source === 'custom') {
        if (!oai.custom_url) {
            throw new ApiError(422, 'validation', 'No custom OpenAI-compatible URL is configured.');
        }
        if (!isValidUrl(String(oai.custom_url)) || !/^https?:$/.test(new URL(String(oai.custom_url)).protocol)) {
            throw new ApiError(422, 'validation', 'Custom OpenAI-compatible URL must be an HTTP(S) URL.');
        }
        if (new URL(String(oai.custom_url)).username || new URL(String(oai.custom_url)).password) throw new ApiError(422, 'validation', 'Custom provider URL must not contain embedded credentials.');
        request.custom_url = String(oai.custom_url);
        request.custom_include_body = String(oai.custom_include_body ?? '');
        request.custom_exclude_body = String(oai.custom_exclude_body ?? '');
        request.custom_include_headers = String(oai.custom_include_headers ?? '');
    }
    if (source === 'claude') {
        request.custom_url = String(oai.reverse_proxy ?? '').trim();
        request.provider_format = 'anthropic-messages';
        request.temperature = Math.min(Number(request.temperature), 1);
    }
    return request;
}

/**
 * Reads and classifies extension manifests for API v1 clients.
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @returns {Array<Record<string, any>>} Extensions
 */
export function listExtensions(session) {
    const roots = [
        { type: 'system', directory: path.join(serverDirectory, 'public', 'scripts', 'extensions') },
        { type: 'local', directory: session.directories.extensions },
        { type: 'global', directory: path.join(serverDirectory, 'public', 'scripts', 'extensions', 'third-party') },
    ];
    const extensions = [];
    for (const root of roots) {
        if (!root.directory || !fs.existsSync(root.directory)) continue;
        const entries = fs.readdirSync(root.directory, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && entry.name !== 'third-party');
        for (const entry of entries) {
            const manifestPath = path.join(root.directory, entry.name, 'manifest.json');
            if (!fs.existsSync(manifestPath)) continue;
            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                const id = root.type === 'system' ? entry.name : `${root.type}/${entry.name}`;
                const disabled = Array.isArray(session.extensionSettings.disabledExtensions)
                    && session.extensionSettings.disabledExtensions.includes(id.replace(/^local\//, 'third-party/').replace(/^global\//, 'third-party/'));
                extensions.push({
                    id,
                    displayName: String(manifest.display_name ?? entry.name),
                    version: String(manifest.version ?? ''),
                    type: root.type,
                    runtime: ['headless', 'webview', 'legacy'].includes(manifest.runtime) ? manifest.runtime : 'legacy',
                    enabled: !disabled,
                    entry: typeof manifest.entry === 'string' ? manifest.entry : null,
                    ui: typeof manifest.ui === 'string' ? manifest.ui : null,
                    capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities : [],
                    hooks: manifest.hooks && typeof manifest.hooks === 'object' ? Object.keys(manifest.hooks) : [],
                    shellUrl: `/api/v1/extensions/${encodeURIComponent(id)}/shell`,
                });
            } catch (error) {
                console.warn('[api-v1] Ignoring invalid extension manifest:', manifestPath, error instanceof Error ? error.message : error);
            }
        }
    }
    return extensions;
}
