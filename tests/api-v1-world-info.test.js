import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from '@jest/globals';
import { buildPrompt } from '../dist/src/headless/prompt.js';
import { readChat, writeChat } from '../dist/src/headless/session.js';

const roots = [];
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-world-info-'));
    roots.push(root);
    const worlds = path.join(root, 'worlds'); fs.mkdirSync(worlds);
    const session = { directories: { root, worlds }, userName: 'Reader', extensionSettings: {}, settings: {
        main_api: 'openai', oai_settings: { chat_completion_source: 'openai', openai_model: 'gpt-4', openai_max_context: 4096, openai_max_tokens: 100, prompts: [{ identifier: 'main', content: 'Main' }], prompt_order: [{ character_id: 100001, order: ['main','worldInfoBefore','worldInfoAfter','dialogueExamples','chatHistory'].map(identifier => ({identifier, enabled:true})) }] },
        power_user: {}, world_info_settings: { world_info: { globalSelect: ['Book'] }, world_info_depth: 2 },
    } };
    const character = { name: 'Aria', description: 'Character description' };
    const chat = [{ chat_metadata: {} }, { name: 'Reader', is_user: true, mes: 'alpha beta' }];
    const entry = (uid, content, extra = {}) => ({ uid, content, key: ['alpha'], keysecondary: [], position: 0, order: 100, ...extra });
    const save = (entries, name = 'Book') => fs.writeFileSync(path.join(worlds, `${name}.json`), JSON.stringify({ entries: Object.fromEntries(entries.map(value => [value.uid, value])) }));
    const build = (options = {}) => buildPrompt(session, character, chat, { type:'normal', characterId:'Aria', chatId:'Chat', ...options });
    return { root, worlds, session, character, chat, entry, save, build };
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive:true, force:true })));
const contents = built => built.messages.map(message => message.content).join('\n');

describe('source-derived World Info execution', () => {
    test('embedded lore follows the selected group character', async () => {
        const f = fixture();
        f.session.settings.world_info_settings.world_info.globalSelect = [];
        f.character.name = 'Bob';
        f.character.character_book = { entries: [{ id: 7, keys: ['alpha'], content: 'Bob lore', enabled: true, position: 'before_char', insertion_order: 10 }] };
        const groupContext = {
            group: { id: 'group', members: ['Aria.png', 'Bob.png'], disabled_members: [], generation_mode: 0 },
            characters: [{ name: 'Aria', avatar: 'Aria.png', data: { name: 'Aria' } }, { ...f.character, avatar: 'Bob.png', data: f.character }],
            characterIndex: 1,
        };
        const built = await f.build({ characterId: 'Bob', groupContext });
        expect(built.warnings.worldInfoActivated).toContain('__embedded__:Bob:7');
        expect(contents(built)).toContain('Bob lore');
    });
    test('group lore character and tag filters use the selected speaker', async () => {
        const f = fixture();
        f.character.name = 'Bob';
        f.session.settings.tag_map = { 'Aria.png': ['aria-tag'], 'Bob.png': ['bob-tag'] };
        f.save([
            f.entry(1, 'Bob tag', { characterFilter: { names: [], tags: ['bob-tag'], isExclude: false } }),
            f.entry(2, 'Aria tag', { characterFilter: { names: [], tags: ['aria-tag'], isExclude: false } }),
            f.entry(3, 'Bob name', { characterFilter: { names: ['Bob'], tags: [], isExclude: false } }),
        ]);
        const groupContext = {
            group: { id: 'group', members: ['Aria.png', 'Bob.png'], disabled_members: [], generation_mode: 0 },
            characters: [{ name: 'Aria', avatar: 'Aria.png', data: { name: 'Aria' } }, { ...f.character, avatar: 'Bob.png', data: f.character }],
            characterIndex: 1,
        };
        const built = await f.build({ characterId: 'Bob', groupContext });
        expect(built.warnings.worldInfoActivated.sort()).toEqual(['Book:1', 'Book:3']);
    });
    test('group lore loads books bound to the selected speaker', async () => {
        const f = fixture();
        f.character.name = 'Bob';
        f.session.settings.world_info_settings.world_info.globalSelect = [];
        f.session.settings.world_info_settings.world_info.charLore = [{ name: 'Bob', extraBooks: ['BobBook'] }];
        f.save([f.entry(1, 'Bob bound lore')], 'BobBook');
        const groupContext = {
            group: { id: 'group', members: ['Aria.png', 'Bob.png'], disabled_members: [], generation_mode: 0 },
            characters: [{ name: 'Aria', avatar: 'Aria.png', data: { name: 'Aria' } }, { ...f.character, avatar: 'Bob.png', data: f.character }],
            characterIndex: 1,
        };
        const built = await f.build({ characterId: 'Bob', groupContext });
        expect(built.warnings.worldInfoActivated).toContain('BobBook:1');
    });
    test('constant, disabled, trigger, decorator and secondary-key logic are evaluated by upstream', async () => {
        const f = fixture();
        f.save([
            f.entry(1,'constant',{key:[],constant:true}), f.entry(2,'disabled',{disable:true}),
            f.entry(3,'trigger',{triggers:['quiet']}), f.entry(4,'@@activate\nforced',{key:['missing']}),
            f.entry(5,'@@dont_activate\nnever',{constant:true}),
            f.entry(6,'any',{selective:true,keysecondary:['beta','missing'],selectiveLogic:0}),
            f.entry(7,'not-all',{selective:true,keysecondary:['beta','missing'],selectiveLogic:1}),
            f.entry(8,'not-any',{selective:true,keysecondary:['missing'],selectiveLogic:2}),
            f.entry(9,'all',{selective:true,keysecondary:['alpha','beta'],selectiveLogic:3}),
            f.entry(10,'fail-all',{selective:true,keysecondary:['missing','beta'],selectiveLogic:3}),
        ]);
        expect((await f.build()).warnings.worldInfoActivated.sort()).toEqual([1,4,6,7,8,9].map(id=>'Book:'+id));
    });
    test('per-entry regex, case, whole words, depth and global field scanning are preserved', async () => {
        const f = fixture(); f.chat[1].mes='Alpha alphabet';
        f.save([f.entry(1,'regex',{key:['/Alph[a-z]+/']}),f.entry(2,'case',{key:['ALPHA'],caseSensitive:true}),f.entry(3,'boundary',{key:['alph'],matchWholeWords:true}),f.entry(4,'field',{key:['Character description'],matchCharacterDescription:true}),f.entry(5,'depth-zero',{scanDepth:0})]);
        expect((await f.build()).warnings.worldInfoActivated.sort()).toEqual(['Book:1','Book:4']);
    });
    test('recursion, delayed levels, exclusions and minimum activation depth use actual scanner buffers', async () => {
        const f=fixture(); f.session.settings.world_info_settings.world_info_recursive=true;
        f.save([f.entry(1,'unlocks second'), f.entry(2,'third',{key:['second'],delayUntilRecursion:1}), f.entry(3,'excluded',{key:['second'],excludeRecursion:true})]);
        expect((await f.build()).warnings.worldInfoActivated).toEqual(['Book:1','Book:2']);
        f.session.settings.world_info_settings.world_info_recursive=false;
        f.session.settings.world_info_settings.world_info_depth=1;
        f.session.settings.world_info_settings.world_info_min_activations=1;
        f.chat.splice(1,0,{name:'Aria',is_user:false,mes:'older-key'});
        f.save([f.entry(8,'older',{key:['older-key']})]);
        expect((await f.build()).warnings.worldInfoActivated).toEqual(['Book:8']);
    });
    test('inclusion-group priority and scoring choose actual upstream winners', async () => {
        const f=fixture();
        f.session.settings.world_info_settings.world_info_use_group_scoring=true;
        f.save([f.entry(1,'weak',{group:'scoring',key:['alpha']}),f.entry(2,'strong',{group:'scoring',key:['alpha','beta']}),f.entry(3,'loser',{group:'priority',order:50}),f.entry(4,'winner',{group:'priority',order:200,groupOverride:true})]);
        expect((await f.build()).warnings.worldInfoActivated.sort()).toEqual(['Book:2','Book:4']);
    });
    test('chat/persona/character/global and embedded books follow upstream selection and de-duplication', async () => {
        const f=fixture();
        for(const name of ['Book','Chat','Persona','Character','Aux']) f.save([f.entry(1,name,{constant:true})],name);
        f.chat[0].chat_metadata.world_info='Chat';
        f.session.settings.power_user.persona_description_lorebook='Persona';
        f.character.extensions={world:'Character'};
        f.session.settings.world_info_settings.world_info.charLore=[{name:'Aria',extraBooks:['Aux','Book','Chat','Persona']}];
        expect((await f.build()).warnings.worldInfoActivated).toEqual(['Chat:1','Persona:1','Character:1','Aux:1','Book:1']);
        delete f.character.extensions;
        f.character.character_book={entries:[{id:7,keys:['alpha'],content:'Embedded',enabled:true,position:'before_char',insertion_order:10}]};
        expect((await f.build()).warnings.worldInfoActivated).toContain('__embedded__:Aria:7');
    });
    test('depth, examples, outlet and author-note positions reach the assembled prompt', async () => {
        const f=fixture();
        f.chat[0].chat_metadata={note_prompt:'Note',note_interval:1,note_depth:0,note_position:1,note_role:0};
        f.session.settings.oai_settings.prompts[0].content='Main {{outlet::my-outlet}}';
        f.save([f.entry(1,'Depth',{position:4,depth:0,role:1}),f.entry(2,'<START>\nReader: Example\nAria: Reply',{position:5}),f.entry(3,'Outlet',{position:7,outletName:'my-outlet'}),f.entry(4,'Before-note',{position:2}),f.entry(5,'After-note',{position:3})]);
        const built=await f.build();
        expect(built.messages[0].content).toBe('Main Outlet');
        expect(built.messages).toContainEqual({role:'user',content:'Depth'});
        expect(built.messages).toContainEqual({role:'system',content:'Before-note\nNote\nAfter-note'});
        expect(built.messages).toContainEqual({role:'system',name:'example_user',content:'Example'});
    });
    test('timed metadata is proposed in isolation and actual cooldown suppresses later reactivation', async () => {
        const f=fixture(); f.save([f.entry(1,'Timed',{cooldown:3})]);
        const first=await f.build();
        expect(first.macroEffects.localDirty).toBe(true);
        expect(f.chat[0].chat_metadata.timedWorldInfo).toBeUndefined();
        f.chat[0].chat_metadata=first.macroEffects.metadata;
        f.chat.push({is_user:true,mes:'alpha',name:'Reader'});
        const second=await f.build();
        expect(second.warnings.worldInfoActivated).toEqual([]);
        const preview=await f.build({preview:true});
        expect(preview.warnings.worldInfoActivated).toEqual(['Book:1']); // Upstream dry-run excludes saved sticky/cooldown effects.
    });
    test('legacy global display regex is migrated for World Info without changing settings', async () => {
        const f = fixture();
        f.save([f.entry(1, 'Old lore')]);
        const legacy = { findRegex: '/Old/g', replaceString: 'Migrated', placement: [0], trimStrings: [] };
        f.session.extensionSettings.regex = [legacy];
        expect(contents(await f.build())).toContain('Migrated lore');
        expect(f.session.extensionSettings.regex).toEqual([legacy]);
    });
    test('World Info regex uses prompt-only and depth gating, capture trimming and explicit scoped consent', async () => {
        const f=fixture();
        f.save([f.entry(1,'[alpha]',{position:4,depth:2})]);
        f.session.extensionSettings.regex=[{findRegex:'/\\[(.*?)\\]/g',replaceString:'GLOBAL $1',trimStrings:[],placement:[5],promptOnly:true,minDepth:1,maxDepth:3}];
        f.character.extensions={regex_scripts:[{findRegex:'/GLOBAL/g',replaceString:'SCOPED',trimStrings:[],placement:[5],promptOnly:true}]};
        expect(contents(await f.build())).toContain('GLOBAL alpha');
        f.session.extensionSettings.character_allowed_regex=['Aria.png'];
        expect(contents(await f.build())).toContain('SCOPED alpha');
    });
    test('missing, corrupt, oversized or unsafe selected books are errors without mutation', async () => {
        const f=fixture();
        await expect(f.build()).rejects.toThrow('missing or unreadable');
        f.save([f.entry(1,'Saved')]); const file=path.join(f.worlds,'Book.json');
        fs.writeFileSync(file,'{bad'); await expect(f.build()).rejects.toThrow('invalid JSON');
        fs.writeFileSync(file,'x'.repeat(4_194_305)); await expect(f.build()).rejects.toThrow('limit');
        f.session.settings.world_info_settings.world_info.globalSelect=['../escape'];
        await expect(f.build()).rejects.toThrow('valid identifier');
    });
    test('preview and actual pure prompt preparation do not rewrite an owned transcript', async () => {
        const f=fixture(); f.save([f.entry(1,'{{incvar::loreCounter}}')]);
        const file=path.join(f.root,'Chat.jsonl'); writeChat(file,f.chat); const before=fs.readFileSync(file,'utf8');
        expect((await f.build({preview:true})).macroEffects.metadata.variables.loreCounter).toBe(1);
        expect((await f.build()).macroEffects.metadata.variables.loreCounter).toBe(1);
        expect(fs.readFileSync(file,'utf8')).toBe(before);
        expect(readChat(file)[0].chat_metadata.variables).toBeUndefined();
    });
    test('concurrent chat requests do not share scanner settings, variable effects or context', async () => {
        const a=fixture(),b=fixture(); a.save([a.entry(1,'A {{incvar::count}}')]); b.save([b.entry(2,'B {{incvar::count}}')]);
        const [one,two]=await Promise.all([a.build(),b.build()]);
        expect(one.warnings.worldInfoActivated).toEqual(['Book:1']); expect(two.warnings.worldInfoActivated).toEqual(['Book:2']);
        expect(one.macroEffects.metadata.variables.count).toBe(1); expect(two.macroEffects.metadata.variables.count).toBe(1);
    });
    test.each([2,3])('Persona author-note placement %s and large WI depths use actual note rules', async position => {
        const f=fixture();
        f.session.settings.power_user={persona_description:'Persona',persona_description_position:position};
        f.chat[0].chat_metadata={note_prompt:'Note',note_interval:1,note_depth:0,note_position:1};
        f.save([f.entry(1,'Before-note',{position:2}),f.entry(2,'After-note',{position:3}),f.entry(3,'Deep',{position:4,depth:200})]);
        const built=await f.build();
        const note = position===2 ? 'Persona\nBefore-note\nNote\nAfter-note' : 'Before-note\nNote\nAfter-note\nPersona';
        expect(built.messages).toContainEqual({role:'system',content:note});
        expect(contents(built)).toContain('Deep');
        f.chat[0].chat_metadata.note_interval=2;
        expect(contents(await f.build())).not.toContain('Note');
    });
    test('relative author notes stay adjacent to main and preset regex needs explicit consent', async () => {
        const f=fixture(); f.save([f.entry(1,'Source')]);
        f.chat[0].chat_metadata={note_prompt:'Before-main',note_interval:1,note_position:2};
        f.session.settings.oai_settings.preset_settings_openai='Owned';
        f.session.settings.oai_settings.extensions={regex_scripts:[{findRegex:'/Source/',replaceString:'Preset',placement:[5],promptOnly:true,trimStrings:[]}]};
        expect((await f.build()).messages.slice(0,2)).toEqual([{role:'system',content:'Before-main'},{role:'system',content:'Main'}]);
        expect(contents(await f.build())).toContain('Source');
        f.session.extensionSettings.preset_allowed_regex={openai:['Owned']};
        expect(contents(await f.build())).toContain('Preset');
    });
    test('pathological WI regex cannot block the host event loop and the next request recovers', async () => {
        const f=fixture(); f.save([f.entry(1,'Never',{key:['/(a+)+$/']})]);
        f.chat[1].mes='a'.repeat(20000)+'!';
        const start=Date.now();
        const pending=f.build();
        // Attach rejection immediately while independently checking host responsiveness.
        const stopped=expect(pending).rejects.toThrow('time limit');
        await new Promise(resolve=>setTimeout(resolve,50));
        expect(Date.now()-start).toBeLessThan(1000);
        await stopped;
        f.save([f.entry(2,'Recovered',{constant:true})]);
        expect(contents(await f.build())).toContain('Recovered');
    },15000);
});
