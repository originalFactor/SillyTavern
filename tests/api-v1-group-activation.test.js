import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import vm from 'node:vm';
import { selectGroupMembers } from '../src/headless/group-activation.js';

const characters = [
    { avatar: 'a.png', name: 'Alice', talkativeness: 0 },
    { avatar: 'b.png', name: 'Bob', talkativeness: 0 },
];
const group = { members: ['a.png', 'b.png'], disabled_members: [], activation_strategy: 0 };
const choose = options => selectGroupMembers({ group, characters, chat: [], random: () => 0.9, ...options });

describe('group member activation', () => {
    test('upstream regeneration removes the trailing batch before selecting speakers', async () => {
        const source = fs.readFileSync(new URL('../public/scripts/group-chats.js', import.meta.url), 'utf8');
        const start = source.indexOf('async function regenerateGroup()');
        const end = source.indexOf('\n}', start);
        const chat = [
            { is_user: true, mes: 'Question' },
            { mes: 'Earlier', extra: { gen_id: 1 } },
            { mes: 'First', extra: { gen_id: 2 } },
            { mes: 'Second', extra: { gen_id: 2 } },
        ];
        let observed;
        const regenerate = vm.runInNewContext(`(${source.slice(start, end + 2)})`, {
            chat, getLastMessageGenerationId: () => chat.at(-1)?.extra?.gen_id,
            deleteLastMessage: async () => { chat.pop(); }, AbortController,
            setExternalAbortController: () => {},
            generateGroupWrapper: async (_auto, type) => { observed = { type, messages: chat.map(message => message.mes) }; },
        });
        await regenerate();
        expect(observed).toEqual({ type: 'normal', messages: ['Question', 'Earlier'] });
    });
    test.each([
        ['legacy last reply', [{ is_user: true, mes: 'User' }, { mes: 'Older', extra: { gen_id: 1 } }, { mes: 'Legacy' }], ['User']],
        ['legacy reply inside a batch', [{ is_user: true, mes: 'User' }, { mes: 'Older', extra: { gen_id: 1 } }, { mes: 'Legacy' }, { mes: 'Latest', extra: { gen_id: 2 } }], ['User', 'Older']],
        ['system boundary', [{ is_user: true, mes: 'User' }, { is_system: true, mes: 'System' }, { mes: 'Latest', extra: { gen_id: 2 } }], ['User', 'System']],
        ['zero generation id', [{ is_user: true, mes: 'User' }, { mes: 'Older', extra: { gen_id: 1 } }, { mes: 'Latest', extra: { gen_id: 0 } }], ['User']],
    ])('upstream regeneration observes the %s boundary', async (_name, chat, expected) => {
        const source = fs.readFileSync(new URL('../public/scripts/group-chats.js', import.meta.url), 'utf8');
        const start = source.indexOf('async function regenerateGroup()');
        const end = source.indexOf('\n}', start);
        let observed;
        const regenerate = vm.runInNewContext(`(${source.slice(start, end + 2)})`, {
            chat, getLastMessageGenerationId: () => chat.at(-1)?.extra?.gen_id,
            deleteLastMessage: async () => { chat.pop(); }, AbortController,
            setExternalAbortController: () => {},
            generateGroupWrapper: async (_auto, type) => { observed = { type, messages: chat.map(message => message.mes) }; },
        });
        await regenerate();
        expect(observed).toEqual({ type: 'normal', messages: expected });
    });
    test('list, pooled and natural selection match the upstream browser functions', () => {
        const source = fs.readFileSync(new URL('../public/scripts/group-chats.js', import.meta.url), 'utf8');
        const extract = name => {
            const start = source.indexOf(`function ${name}(`);
            const end = source.indexOf('\n}', start);
            if (start < 0 || end < 0) throw new Error(`Missing upstream ${name}`);
            return source.slice(start, end + 2);
        };
        const chat = [{ is_user: true }, { original_avatar: 'a.png' }];
        const upstream = vm.runInNewContext(`${extract('activateListOrder')}\n${extract('activatePooledOrder')}\n${extract('activateNaturalOrder')}\n({ activateListOrder, activatePooledOrder, activateNaturalOrder })`, {
            characters, chat, onlyUnique: (value, index, array) => array.indexOf(value) === index,
            system_message_types: { NARRATOR: 'narrator' }, Math: { floor: Math.floor, random: () => 0.9 },
            isNaN, Number, talkativeness_default: 0.5,
            extractAllWords: value => Array.from(String(value ?? '').matchAll(/\b\w+\b/gim), match => match[0].toLowerCase()),
            shuffle: values => values,
        });
        const avatars = indexes => Array.from(indexes, index => characters[index].avatar);
        expect(choose({ group: { ...group, activation_strategy: 1 }, chat })).toEqual(avatars(upstream.activateListOrder(group.members)));
        expect(choose({ group: { ...group, activation_strategy: 3 }, chat })).toEqual(avatars(upstream.activatePooledOrder(group.members, chat.at(-1), false)));
        expect(choose({ input: 'Hello Alice' })).toEqual(avatars(upstream.activateNaturalOrder(group.members, 'Hello Alice', undefined, false, true)));
    });
    test('list order skips disabled and missing characters', () => {
        expect(choose({ group: { ...group, activation_strategy: 1, members: ['b.png', 'missing.png', 'a.png'], disabled_members: ['a.png'] } })).toEqual(['b.png']);
    });
    test('natural activation resolves mentions and excludes the last speaker', () => {
        expect(choose({ input: 'Hello Alice' })).toEqual(['a.png']);
        expect(choose({ chat: [{ name: 'Alice', mes: 'Alice Bob', is_user: false }] })).toEqual(['b.png']);
    });
    test.each([0, 0.2, 0.5, 0.9])('natural activation agrees with upstream at random value %s', randomValue => {
        const source = fs.readFileSync(new URL('../public/scripts/group-chats.js', import.meta.url), 'utf8');
        const start = source.indexOf('function activateNaturalOrder(');
        const end = source.indexOf('\n}', start);
        const talkative = characters.map(item => ({ ...item, talkativeness: 0.5 }));
        const random = () => randomValue;
        const shuffle = values => {
            for (let count = values.length; count > 0; count--) {
                const index = Math.floor(random() * count);
                [values[count - 1], values[index]] = [values[index], values[count - 1]];
            }
            return values;
        };
        const upstream = vm.runInNewContext(`(${source.slice(start, end + 2)})`, {
            characters: talkative, Math: { random, floor: Math.floor }, isNaN, Number, shuffle,
            talkativeness_default: 0.5, onlyUnique: (value, index, array) => array.indexOf(value) === index,
            extractAllWords: value => Array.from(String(value ?? '').matchAll(/\b\w+\b/gim), match => match[0].toLowerCase()),
        });
        const expected = Array.from(upstream(group.members, 'Alice', undefined, false, true), index => talkative[index].avatar);
        expect(selectGroupMembers({ group, characters: talkative, chat: [], input: 'Alice', random })).toEqual(expected);
    });
    test('manual user input activates nobody and auto mode chooses a member', () => {
        const manual = { ...group, activation_strategy: 2 };
        expect(choose({ group: manual, input: 'hello' })).toEqual([]);
        expect(choose({ group: manual, auto: true })).toHaveLength(1);
    });
    test('pooled order prefers members who have not spoken since the user', () => {
        const pooled = { ...group, activation_strategy: 3 };
        expect(choose({ group: pooled, chat: [{ is_user: true }, { original_avatar: 'a.png' }] })).toEqual(['b.png']);
    });
    test('swipe and continue select the previous speaker including a disabled member', () => {
        const disabled = { ...group, disabled_members: ['a.png'] };
        const chat = [{ name: 'Alice', original_avatar: 'a.png' }];
        expect(choose({ group: disabled, chat, type: 'swipe' })).toEqual(['a.png']);
        expect(choose({ group: disabled, chat, type: 'continue' })).toEqual(['a.png']);
    });
    test('quiet falls back to the first member and forced selection uses character index', () => {
        expect(choose({ type: 'quiet' })).toEqual(['a.png']);
        expect(choose({ forcedCharacterIndex: 1 })).toEqual(['b.png']);
    });
});
