import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, test } from '@jest/globals';

const clientRoot = path.resolve('client');
const cache = new Map();
function clientModule(file) {
    const filename = path.resolve(file);
    if (cache.has(filename)) return cache.get(filename);
    if (!filename.startsWith(clientRoot + path.sep)) throw new Error('Unexpected module outside client');
    const source = fs.readFileSync(filename, 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    const exports = {};
    cache.set(filename, exports);
    new Function('exports', 'require', outputText)(exports, specifier => {
        if (!specifier.startsWith('.')) throw new Error('Unexpected non-local module');
        return clientModule(path.resolve(path.dirname(filename), specifier + '.ts'));
    });
    return exports;
}
const { messages, isLocale, detectLocale, translate } = clientModule(path.join(clientRoot, 'lib/i18n-core.ts'));
const placeholders = text => [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match => match[1]).sort();

describe('client en-US / zh-CN catalogs', () => {
    test('both locales have every source key and identical interpolation parameters', () => {
        expect(Object.keys(messages['en-US']).sort()).toEqual(Object.keys(messages['zh-CN']).sort());
        expect(Object.keys(messages['en-US']).length).toBeGreaterThan(300);
        for (const [key, chinese] of Object.entries(messages['zh-CN'])) {
            expect(messages['en-US'][key]).toBe(key);
            expect(chinese.trim()).not.toBe('');
            expect(placeholders(chinese)).toEqual(placeholders(key));
        }
    });
    test('all literal translation calls reference an existing catalog entry', () => {
        const files = ['app/page.tsx', ...fs.readdirSync(path.join(clientRoot, 'components')).filter(name => name.endsWith('.tsx')).map(name => 'components/' + name)];
        const missing = [];
        for (const file of files) {
            const ast = ts.createSourceFile(file, fs.readFileSync(path.join(clientRoot, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
            function visit(node) {
                if (ts.isCallExpression(node) && node.expression.getText(ast) === 't' && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && !Object.hasOwn(messages['en-US'], node.arguments[0].text)) missing.push(`${file}: ${node.arguments[0].text}`);
                ts.forEachChild(node, visit);
            }
            visit(ast);
        }
        expect(missing).toEqual([]);
    });
    test('translates source messages and falls back without changing unknown diagnostics', () => {
        expect(translate('zh-CN', 'API settings')).toBe('API 设置');
        expect(translate('en-US', 'API settings')).toBe('API settings');
        expect(translate('zh-CN', 'Remote detail: quota reached')).toBe('Remote detail: quota reached');
        expect(translate('zh-CN', 'toString')).toBe('toString');
        expect(translate('zh-CN', '__proto__')).toBe('__proto__');
    });
    test('interpolates values once without translating user content or reinterpreting braces', () => {
        expect(translate('zh-CN', 'Entry {id}', { id: 'Forest {id}' })).toBe('条目 Forest {id}');
        expect(translate('en-US', 'Item {number}', { number: 0 })).toBe('Item 0');
        expect(translate('zh-CN', 'Entry {id}')).toBe('条目 {id}');
        expect(translate('en-US', 'Hello, {{user}}!')).toBe('Hello, {{user}}!');
    });
});

describe('client language negotiation', () => {
    test.each(['en-US', 'zh-CN'])('accepts supported saved locale %s', locale => expect(isLocale(locale)).toBe(true));
    test.each(['zh', 'zh-TW', 'en', '', 'fr-FR', null, undefined, '__proto__'])('rejects unsupported saved preference %s', locale => expect(isLocale(locale)).toBe(false));
    test.each([
        ['zh-CN,zh;q=0.9,en-US;q=0.8', 'zh-CN'],
        ['en-GB,en;q=0.9,zh-CN;q=0.5', 'en-US'],
        ['en-US;q=0.2,zh-CN;q=0.9', 'zh-CN'],
        ['zh-CN;q=0,en-US;q=0.5', 'en-US'],
        ['zh-CN;q=invalid,en-US', 'en-US'],
        ['zh-CN;q=2,en-US', 'en-US'],
        ['fr-FR,zh-Hans;q=0.5', 'zh-CN'],
        [['fr-FR', 'zh-TW', 'en-US'], 'zh-CN'],
        ['fr-FR', 'en-US'],
        [null, 'en-US'],
    ])('negotiates %s as %s', (languages, expected) => expect(detectLocale(languages)).toBe(expected));
});
