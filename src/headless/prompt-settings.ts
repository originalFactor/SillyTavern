import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from './contract.js';
import { serverDirectory } from '../server-directory.js';
import { classifyExtension } from './virtual-dom.js';
import { packageRestartPending } from './package-management.js';

/**
 * Builds a provider request from saved settings only.
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @param {Array<{role: string, content: string}>} messages Chat Completion messages
 * @returns {Record<string, any>} Provider request
 */
export function buildProviderRequest(session: import('./session.js').HeadlessSession, messages: any, overrides: Record<string, any> = {}) {
    if (session.settings.main_api !== 'openai') throw new ApiError(422, 'unsupported', 'Only the OpenAI Chat Completions provider is supported by this headless backend.');
    const oai = session.settings.oai_settings ?? {};
    const source = String(oai.chat_completion_source ?? 'openai');
    if (!['openai', 'custom'].includes(source)) throw new ApiError(422, 'unsupported', 'Only OpenAI Chat Completions and compatible custom endpoints are supported by this headless backend.');
    const model = overrides.model ?? (source === 'custom' ? oai.custom_model : oai.openai_model);
    if (!model) {
        throw new ApiError(422, 'validation', 'No Chat Completion model is configured.');
    }
    const request: Record<string, any> = {
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
    return request;
}

/**
 * Reads and classifies extension manifests for API v1 clients.
 * @param {import('./session.js').HeadlessSession} session Headless session
 * @returns {Array<Record<string, any>>} Extensions
 */
export function listExtensions(session: import('./session.js').HeadlessSession): Array<Record<string, any>> {
    const roots = [
        { type: 'system', directory: path.join(serverDirectory, 'compat-source/upstream', 'scripts', 'extensions') },
        { type: 'local', directory: session.directories.extensions },
        { type: 'global', directory: path.join(serverDirectory, 'compat-source/upstream', 'scripts', 'extensions', 'third-party') },
    ];
    const extensions: Array<Record<string, any>> = [];
    for (const root of roots) {
        if (!root.directory || !fs.existsSync(root.directory)) continue;
        const entries = fs.readdirSync(root.directory, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && entry.name !== 'third-party');
        for (const entry of entries) {
            const manifestPath = path.join(root.directory, entry.name, 'manifest.json');
            if (!fs.existsSync(manifestPath)) continue;
            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                const compatibility = classifyExtension(manifest);
                const id = root.type === 'system' ? entry.name : `${root.type}/${entry.name}`;
                const disabled = packageRestartPending(path.join(root.directory, entry.name)) || (Array.isArray(session.extensionSettings.disabledExtensions)
                    && session.extensionSettings.disabledExtensions.includes(id.replace(/^local\//, 'third-party/').replace(/^global\//, 'third-party/')));
                extensions.push({
                    id,
                    displayName: String(manifest.display_name ?? entry.name),
                    version: String(manifest.version ?? ''),
                    type: root.type,
                    runtime: ['headless', 'server-plugin', 'virtual-dom', 'webview', 'legacy'].includes(manifest.runtime) ? manifest.runtime : 'legacy',
                    compatibilityStatus: compatibility.status,
                    compatibilityDiagnostic: compatibility.diagnostic,
                    enabled: !disabled,
                    entry: typeof manifest.entry === 'string' ? manifest.entry : null,
                    ui: typeof manifest.ui === 'string' ? manifest.ui : null,
                    capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities : [],
                    hooks: manifest.hooks && typeof manifest.hooks === 'object' ? Object.keys(manifest.hooks) : [],
                    uiUrl: `/api/v1/extensions/${encodeURIComponent(id)}/ui`,
                    settingsNamespace: typeof manifest.settings_namespace === 'string' ? manifest.settings_namespace : entry.name,
                    browserUiDeclared: Boolean(manifest.js || manifest.ui || manifest.entry && !['headless', 'server-plugin'].includes(manifest.runtime)),
                });
            } catch (error) {
                console.warn('[api-v1] Ignoring invalid extension manifest:', manifestPath, error instanceof Error ? error.message : error);
            }
        }
    }
    return extensions;
}
