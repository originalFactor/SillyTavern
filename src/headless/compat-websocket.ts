/** Authenticated, bounded WebSocket transport for Messenger extension RPC. */
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_DEADLINE_MS = 30_000;
const ROUTE_ALLOWLIST = [
    /^\/(?:characters|chats|groups|personas|presets|prompt-manager|regex|world-info|macros|extensions|settings|generation|providers)(?:\/|$)/,
];
const SECRET_ROUTES = [/^\/providers\/credentials(?:\/|$)/, /^\/secrets(?:\/|$)/];

function capabilityMatches(header: any, tokenBytes: any) {
    const value = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    const bytes = /^[0-9a-f]{64}$/.test(value) ? Buffer.from(value, 'hex') : Buffer.alloc(0);
    return bytes.length === tokenBytes.length && crypto.timingSafeEqual(bytes, tokenBytes);
}

function safeError(error: any) {
    return String(error instanceof Error ? error.message : error).slice(0, 1024);
}

function validRequest(message: any) {
    return message && message.type === 'request'
        && typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 128
        && Number.isSafeInteger(message.seq) && message.seq > 0
        && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(message.method)
        && typeof message.path === 'string' && message.path.startsWith('/');
}

/**
 * Attach the /compat/ws endpoint. The caller owns closing the returned server.
 * @param {import('node:http').Server} server
 * @param {string} token
 * @param {number} port
 */
export function attachCompatWebSocket(server: any, token: string, port: number) {
    const tokenBytes = Buffer.from(token, 'hex');
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
    server.on('upgrade', (request: any, socket: any, head: any) => {
        let pathname;
        try { pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname; } catch { socket.destroy(); return; }
        if (pathname !== '/compat/ws') { socket.destroy(); return; }
        if (!capabilityMatches(request.headers.authorization, tokenBytes)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        // The native host has no web origin. Reject browser origins so a page
        // cannot use ambient WebSocket access even if it learns the port.
        if (request.headers.origin) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(request, socket, head, (ws: any) => wss.emit('connection', ws, request));
    });

    wss.on('connection', (ws: any) => {
        let lastSeq = 0;
        const ids = new Set();
        const controllers = new Set<AbortController>();
        let queue = Promise.resolve();
        ws.send(JSON.stringify({ type: 'host-event', event: 'connected', version: 1, maxPayloadBytes: MAX_MESSAGE_BYTES }));
        ws.on('message', (raw: any) => {
            if (raw.length > MAX_MESSAGE_BYTES) { ws.close(1009, 'Message too large'); return; }
            let message;
            try { message = JSON.parse(raw.toString('utf8')); } catch { ws.close(1007, 'Invalid JSON'); return; }
            if (!validRequest(message) || message.seq !== lastSeq + 1 || ids.has(message.id) || ids.size >= 10_000) {
                ws.close(1008, 'Invalid request or sequence');
                return;
            }
            lastSeq = message.seq;
            ids.add(message.id);
            queue = queue.then(async () => {
                if (ws.readyState !== ws.OPEN) return;
                const deadlineMs = Number.isInteger(message.deadlineMs) ? Math.max(100, Math.min(MAX_DEADLINE_MS, message.deadlineMs)) : 10_000;
                const pathname = message.path.split('?')[0];
                if (message.path.includes('\\') || /[\u0000-\u001f]/.test(message.path) || pathname.includes('..') || pathname.startsWith('//')) {
                    ws.send(JSON.stringify({ type: 'result', id: message.id, seq: message.seq, ok: false, error: { code: 'invalid_request', message: 'Host API path is invalid.' } }));
                    return;
                }
                if (!ROUTE_ALLOWLIST.some(pattern => pattern.test(pathname)) || SECRET_ROUTES.some(pattern => pattern.test(pathname))) {
                    ws.send(JSON.stringify({ type: 'result', id: message.id, seq: message.seq, ok: false, error: { code: 'unsupported', message: 'This host API route is not available to extensions.' } }));
                    return;
                }
                const controller = new AbortController();
                controllers.add(controller);
                const timer = setTimeout(() => controller.abort(), deadlineMs);
                timer.unref?.();
                try {
                    const response = await fetch(`http://127.0.0.1:${port}/api/v1${message.path}`, {
                        method: message.method,
                        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                        ...(message.body === undefined ? {} : { body: JSON.stringify(message.body) }),
                        signal: controller.signal,
                        redirect: 'error',
                    });
                    const text = await response.text();
                    if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES / 2) throw new Error('Host response exceeds the RPC limit.');
                    let body;
                    try { body = text ? JSON.parse(text) : null; } catch { body = { message: text.slice(0, 4096) }; }
                    const result = { type: 'result', id: message.id, seq: message.seq, ok: response.ok, status: response.status, body };
                    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(result));
                } catch (error) {
                    const timedOut = controller.signal.aborted;
                    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({
                        type: 'result', id: message.id, seq: message.seq, ok: false,
                        error: { code: timedOut ? 'timeout' : 'disconnected', message: timedOut ? `Host request exceeded ${deadlineMs}ms.` : safeError(error), mutationOutcome: 'unknown' },
                    }));
                } finally { clearTimeout(timer); controllers.delete(controller); }
            }).catch(() => { if (ws.readyState === ws.OPEN) ws.close(1011, 'RPC dispatch failed'); });
        });
        ws.on('close', () => {
            for (const controller of controllers) controller.abort();
            controllers.clear();
            ids.clear();
        });
    });
    return { close: () => new Promise(resolve => wss.close(resolve)) };
}
