import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVirtualDOM, classifyExtension, runVirtualDOMExtension } from '../dist/src/headless/virtual-dom.js';

describe('headless virtual DOM', () => {
    test('supports DOM mutation, selectors, events, and jQuery', () => {
        const dom = createVirtualDOM();
        const button = dom.document.createElement('button');
        button.setAttribute('data-action', 'go');
        button.textContent = 'Run';
        dom.document.body.append(button);
        let clicked = false;
        dom.$('[data-action=go]').on('click', () => { clicked = true; }).trigger('click');
        expect(clicked).toBe(true);
        expect(dom.document.querySelector('button').textContent).toBe('Run');
        expect(dom.emit().text).toBe('Run');
    });

    test('fails explicitly for browser services', () => {
        const dom = createVirtualDOM();
        expect(() => dom.window.getComputedStyle(dom.document.body)).toThrow('Unsupported browser API');
        expect(dom.diagnostics).toHaveLength(1);
    });

    test('classifies unsupported legacy requirements with a diagnostic', () => {
        expect(classifyExtension({ runtime: 'browser' })).toMatchObject({ status: 'skipped' });
        expect(classifyExtension({ runtime: 'virtual-dom' })).toMatchObject({ status: 'supported-adapter' });
    });

    test('runs an explicitly selected extension and collects its UI output', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-virtual-dom-'));
        try {
            const entry = path.join(dir, 'extension.mjs');
            fs.writeFileSync(entry, 'export async function init({ $, document }) { $(document.body).append("<button>Ready</button>"); }');
            await expect(runVirtualDOMExtension(entry)).resolves.toMatchObject({ text: 'Ready', html: expect.stringContaining('<button>Ready</button>') });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
