/**
 * Small server-side DOM surface for extensions that only build and query UI.
 * It intentionally has no layout engine, navigation, storage, or network.
 */
import { parseHTML } from 'linkedom';
import jquery from 'jquery';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const unsupported = new Set([
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
    'localStorage', 'sessionStorage', 'indexedDB', 'open', 'alert', 'confirm', 'prompt',
]);

/**
 * Create an isolated, non-layout DOM and a jQuery instance for one extension.
 * UI output is returned to the host as a fragment; it is never served directly.
 * @param {string} html Initial document markup
 * @param {(output: {html: string, text: string}) => void} host Optional headless host sink
 */
export function createVirtualDOM(html: string = '<!doctype html><html><body></body></html>', host: (fragment: any) => void = () => {}) {
    const { window, document } = parseHTML(html);
    (window as any).location ??= { href: 'http://headless.invalid/' };
    (document as any).implementation ??= {};
    (document as any).implementation.createHTMLDocument ??= (title: any) => {
        const parsed = parseHTML('<!doctype html><html><head></head><body></body></html>');
        parsed.document.title = String(title ?? '');
        return parsed.document;
    };
    const $ = jquery(window);
    const diagnostics: any[] = [];
    const fail = (name: any) => () => {
        const message = `Unsupported browser API: ${name} (virtual DOM has no layout or browser services).`;
        diagnostics.push(message);
        throw new Error(message);
    };
    for (const name of unsupported) {
        if (name in window) {
            try { Object.defineProperty(window, name, { configurable: true, value: fail(name) }); } catch { /* immutable runtime property */ }
        } else {
            Object.defineProperty(window, name, { configurable: true, value: fail(name) });
        }
    }
    $.ajax = fail('jQuery.ajax / browser networking');
    const exposedWindow = new Proxy(window, {
        get(target, property, receiver) {
            if (unsupported.has(String(property))) return fail(String(property));
            return Reflect.get(target, property, receiver);
        },
    });
    const emit = (root = document.body) => {
        const output = { html: root.innerHTML ?? '', text: root.textContent ?? '' };
        host(output);
        return output;
    };
    return Object.freeze({ window: exposedWindow, document, $, emit, diagnostics });
}

/**
 * Describe compatibility requirements from extension metadata.
 * @param {Record<string, any>} manifest Extension manifest
 */
export function classifyExtension(manifest: Record<string, any> = {}) {
    const declared = manifest.compatibility ?? manifest.capabilities ?? {};
    const requirements = Array.isArray(declared)
        ? declared
        : [declared.headless && 'headless', declared.serverPlugin && 'server-plugin', declared.virtualDom && 'virtual-dom'].filter(Boolean);
    const runtime = manifest.runtime ?? (requirements.includes('server-plugin') ? 'server-plugin' : requirements.includes('virtual-dom') ? 'virtual-dom' : 'browser');
    const supported = new Set(['headless', 'server-plugin', 'virtual-dom']);
    return {
        runtime,
        requirements,
        status: supported.has(runtime) ? 'supported-adapter' : 'skipped',
        diagnostic: supported.has(runtime) ? null : `No headless adapter is declared for runtime "${runtime}".`,
    };
}

/**
 * Load an explicitly selected legacy extension in a bounded worker and collect
 * the UI fragment it emits through the virtual host.
 * @param {string} entry Absolute extension module path
 * @param {{html?: string, timeoutMs?: number}} [options] Runtime options
 * @returns {Promise<{html: string, text: string, diagnostics: string[]}>
 */
export function runVirtualDOMExtension(entry: string, options: Record<string, any> = {}) {
    const worker = new Worker(new URL('./virtual-dom-worker.js', import.meta.url), {
        workerData: { entry: pathToFileURL(entry).href, html: options.html, timeoutMs: options.timeoutMs },
        resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
    });
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(100, Math.min(options.timeoutMs, 30_000)) : 5_000;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error(`Virtual DOM extension timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
        worker.once('message', result => {
            clearTimeout(timer);
            worker.terminate();
            result?.ok ? resolve(result.output) : reject(new Error(result?.error ?? 'Virtual DOM extension failed.'));
        });
        worker.once('error', error => { clearTimeout(timer); reject(error); });
        worker.once('exit', code => {
            if (code !== 0) { clearTimeout(timer); reject(new Error(`Virtual DOM worker exited with code ${code}.`)); }
        });
    });
}
