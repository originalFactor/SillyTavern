#!/usr/bin/env node
/** Minimal native-side Messenger RPC client for the companion WebSocket. */
import WebSocket from 'ws';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export class ExtensionRpcClient {
    #socket;
    #sequence = 0;
    #pending = new Map();
    #ready;

    /**
     * @param {{port: number, capability: string, timeoutMs?: number}} options
     */
    constructor({ port, capability, timeoutMs = 10_000 }) {
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('A valid loopback port is required.');
        if (!/^[0-9a-f]{64}$/.test(capability ?? '')) throw new TypeError('A 32-byte companion capability is required.');
        this.timeoutMs = Math.max(100, Math.min(30_000, timeoutMs));
        this.#socket = new WebSocket(`ws://127.0.0.1:${port}/compat/ws`, {
            headers: { Authorization: `Bearer ${capability}` },
            perMessageDeflate: false,
            maxPayload: 1024 * 1024,
        });
        this.#ready = new Promise((resolve, reject) => {
            this.#socket.once('open', resolve);
            this.#socket.once('error', reject);
        });
        this.#socket.on('message', raw => this.#receive(raw));
        this.#socket.on('close', () => {
            for (const { reject, timer } of this.#pending.values()) {
                clearTimeout(timer);
                reject(new Error('Companion WebSocket disconnected; mutation outcome may be unknown.'));
            }
            this.#pending.clear();
        });
        this.#socket.on('error', error => {
            for (const { reject, timer } of this.#pending.values()) {
                clearTimeout(timer);
                reject(new Error(`Companion WebSocket failed: ${error.message}`));
            }
            this.#pending.clear();
        });
    }

    /** Make exactly one API call. A timeout is surfaced and never retried. */
    async call(method, apiPath, body, options = {}) {
        await this.#ready;
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new TypeError('Unsupported host RPC method.');
        if (typeof apiPath !== 'string' || !apiPath.startsWith('/') || apiPath.startsWith('//')) throw new TypeError('API path must be relative to /api/v1.');
        const id = `rpc-${Date.now().toString(36)}-${++this.#sequence}`;
        const seq = this.#sequence;
        const deadlineMs = Math.max(100, Math.min(30_000, options.deadlineMs ?? this.timeoutMs));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error(`Companion RPC timed out after ${deadlineMs}ms; mutation outcome may be unknown.`));
            }, deadlineMs);
            this.#pending.set(id, { seq, resolve, reject, timer });
            try {
                this.#socket.send(JSON.stringify({ type: 'request', id, seq, method, path: apiPath, ...(body === undefined ? {} : { body }), deadlineMs }));
            } catch (error) {
                clearTimeout(timer);
                this.#pending.delete(id);
                reject(error);
            }
        });
    }

    close() {
        this.#socket.close();
    }

    #receive(raw) {
        let message;
        try { message = JSON.parse(raw.toString('utf8')); } catch { this.#socket.close(1007, 'Invalid JSON from companion'); return; }
        if (message.type !== 'result') return;
        const pending = this.#pending.get(message.id);
        if (!pending || pending.seq !== message.seq) return;
        clearTimeout(pending.timer);
        this.#pending.delete(message.id);
        pending.resolve(message);
    }
}

async function main() {
    const port = Number(process.env.ST_COMPANION_PORT);
    const capability = process.env.ST_COMPANION_CAPABILITY;
    const client = new ExtensionRpcClient({ port, capability });
    try {
        const result = await client.call('GET', '/characters');
        if (!result.ok) throw new Error(`Companion returned HTTP ${result.status}.`);
        const names = (result.body?.characters ?? []).map(character => character.name).filter(name => typeof name === 'string');
        process.stdout.write(`${JSON.stringify({ connected: true, characters: names.length, sample: names.slice(0, 3) })}\n`);
    } finally { client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
