// Run after `pnpm build` and `pnpm --dir client build` with CLIENT_BROWSER_TEST=1.
// Uses installed Chrome/CDP and the existing ws dependency; no browser package
// download, real user data, credentials, or provider requests are involved.
// Set CLIENT_BROWSER_DEV=1 to check development-only hydration diagnostics too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { readExtensionUi } from '../dist/src/headless/extension-ui.js';

const browserDescribe = process.env.CLIENT_BROWSER_TEST === '1' ? describe : describe.skip;
const clientRequire = createRequire(new URL('../client/package.json', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

browserDescribe('V1 client browser workflows', () => {
    let web, chrome, socket, port, profile, session, sequence = 0;
    let moduleProbeBundle, printProbeBundle, useModuleProbe = false, usePrintProbe = false, failPrintRead = false;
    const responses = new Map(), listeners = new Map(), requests = [], violations = [], errors = [], hydrationErrors = [], chatQueries = [], cancelledRequests = new Set();
    let providerStatus = { onlineStatus: 'no_connection', state: 'unchecked', checkedAt: null }, failProviderCheck = false;
    let caller, generation, generationPosts = 0, editPosts = 0, failCard = true, dropNext = false;
    let card = { id: 'ada', name: 'Ada', revision: 'card-1', raw: { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Ada', description: 'Original', first_mes: 'Hello', extensions: { vendor: { keep: true } } }, opaque: [1, 2] } };
    let prompts = { revision: 'prompt-1', prompts: [{ identifier: 'main', name: 'Main', content: 'System content', role: 'system', future: { keep: true } }, { identifier: 'history', name: 'History', role: 'user', content: 'History content' }], order: [{ identifier: 'main', enabled: true }, { identifier: 'history', enabled: true }] };
    let message = { index: 41, name: 'Ada', mes: 'Original reply', is_user: false, swipes: ['Original reply', 'Alternative'], swipe_id: 0 };
    let personas = { revision: 'persona-1', selectedId: '', username: 'Custom user', personas: [{ id: 'user.png', name: 'Reader', title: '', description: 'A reader', position: 0, depth: 2, role: 0, lorebook: '' }] };
    let book = { name: 'Forest', revision: 'book-1', book: { entries: { 9: { uid: 9, key: ['forest'], content: 'Old lore', comment: 'Forest entry', future: { keep: true } } }, extensions: { keep: true } } };
    let regex = { revision: 'regex-1', settings: { enabled: true, scripts: [{ findRegex: '/x/g', replaceString: 'y', placement: [1], future: true }], characterAllowed: [], presetAllowed: {} } };
    let variables = { revision: 'variables-1', variables: { count: '1', future: { keep: true } }, experimental: true };
    let team = { id: 'team', revision: 'team-1', group: { name: 'Team', members: ['ada.png'], disabled_members: [], chats: ['shared'], chat_id: 'shared', activation_strategy: 0, generation_mode: 0, future: { keep: true } } };
    let groupMessage = { index: 0, name: 'Ada', original_avatar: 'ada.png', mes: 'Group raw', is_user: false };
    let groupSampling = { revision: 'sampling-1', overrides: { temperature: 0.5 } };
    let extensionSettings = { extensionId: 'local/ui-demo', namespace: 'ui-demo', revision: 'ext-1', settings: { enabled: false, opaque: { keep: true } } };
    let pluginInventory = { enabled: true, revision: 'packages-1', packages: [
        { kind: 'extension', name: 'demo', id: 'local/demo', manageable: true, repository: 'https://example.test/demo.git', commit: 'abc123' },
        { kind: 'server-plugin', name: 'service', id: 'service', manageable: true, repository: 'https://example.test/service.git' },
        { kind: 'extension', name: 'builtin', id: 'builtin', manageable: false, diagnostic: 'System extension' },
    ] };
    let failPluginAction = false;
    const extensionBase = 'https://extension.invalid/scripts/extensions/ui-demo/';
    const extensionBundle = {
        extensionId: 'local/ui-demo', name: 'ui-demo', namespace: 'ui-demo', base: extensionBase, entries: [extensionBase + 'index.js'],
        modules: { [extensionBase + 'index.js']: `import {extension_settings,extensionNames,extensionTypes,saveMetadataDebounced,renderExtensionTemplateAsync,saveSettingsDebounced} from 'https://extension.invalid/scripts/extensions.js';
import getContext from 'https://extension.invalid/scripts/st-context.js';
import {eventSource,event_types} from 'https://extension.invalid/scripts/events.js';
import {Popup,POPUP_TYPE} from 'https://extension.invalid/scripts/popup.js';
import {getStringHash,getImageSizeFromDataURL,ensureImageFormatSupported,getSanitizedFilename,getCharaFilename,showFontAwesomePicker,download,countOccurrences as utilityCount,trimToEndSentence} from 'https://extension.invalid/scripts/utils.js';
import {MAX_INJECTION_DEPTH,extension_prompt_types,extension_prompt_roles,getExtensionPromptRoleByName,createLazyFields,countOccurrences,system_message_types,user_avatar as scriptAvatar,name1,name2,online_status,is_send_press,isGenerating,main_api,getCurrentChatId,getMaxContextTokens,getMaxResponseTokens,getMaxPromptTokens,getMaxContextSize,cleanUpMessage,baseChatReplace,parseMesExamples} from 'https://extension.invalid/script.js';
import {t,addLocaleData,getCurrentLocale} from 'https://extension.invalid/scripts/i18n.js';
import libraries,{lodash,moment,Bowser} from 'https://extension.invalid/lib.js';
import {Prompt,PromptCollection} from 'https://extension.invalid/scripts/PromptManager.js';
import {SlashCommand} from 'https://extension.invalid/scripts/slash-commands/SlashCommand.js';
import {SlashCommandParser} from 'https://extension.invalid/scripts/slash-commands/SlashCommandParser.js';
import {SlashCommandNamedArgument,ARGUMENT_TYPE} from 'https://extension.invalid/scripts/slash-commands/SlashCommandArgument.js';
import {loadWorldInfo,world_names,selected_world_info,world_info,world_info_include_names,getWorldInfoSettings,newWorldInfoEntryTemplate,convertCharacterBook,saveWorldInfo} from 'https://extension.invalid/scripts/world-info.js';
import {getEventSourceStream} from 'https://extension.invalid/scripts/sse-stream.js';
import {getTokenCount,getTokenCountAsync,guesstimate} from 'https://extension.invalid/scripts/tokenizers.js';
import {isAdmin,getCurrentUserHandle,accountsEnabled} from 'https://extension.invalid/scripts/user.js';
import {MacrosParser,getLastMessageId} from 'https://extension.invalid/scripts/macros.js';
import {getPresetManager} from 'https://extension.invalid/scripts/preset-manager.js';
import {getRegexedString,runRegexScript,getRegexScripts,getScriptsByType,SCRIPT_TYPES,regex_placement,RegexProvider,getCurrentPresetName,allowPresetScripts} from 'https://extension.invalid/scripts/extensions/regex/engine.js';
import {NOTE_MODULE_NAME,metadata_keys,shouldWIAddPrompt,setFloatingPrompt} from 'https://extension.invalid/scripts/authors-note.js';
import {isMobile,getParsedUA,humanizeGenTime,humanizedDateTime,getMessageTimeStamp} from 'https://extension.invalid/scripts/RossAscends-mods.js';
import {debounce_timeout,IGNORE_SYMBOL,inject_ids,MEDIA_TYPE} from 'https://extension.invalid/scripts/constants.js';
import {persona_description_positions as personaPositions} from 'https://extension.invalid/scripts/personas.js';
import {persona_description_positions,send_on_enter_options,collapseNewlines,fixMarkdown} from 'https://extension.invalid/scripts/power-user.js';
export async function init(){
  if(is_send_press!==false || isGenerating()!==false || getContext().isGenerating!==isGenerating) throw Error('Initial native generation state failed');
  if(online_status!=='no_connection' || getContext().onlineStatus!==online_status) throw Error('Native provider status initialization failed');
  const statusOutput=document.createElement('output');statusOutput.id='online-status';
  let statusEvents=[];
  const showStatus=()=>{statusOutput.textContent=JSON.stringify({value:online_status,context:getContext().onlineStatus,events:statusEvents})};
  showStatus();document.body.append(statusOutput);
  eventSource.on(event_types.ONLINE_STATUS_CHANGED,value=>{statusEvents.push(value);showStatus()});
  if(cleanUpMessage({getMessage:'  * text *  \\n\\nComplete.<|endoftext|>ignored',stoppingStrings:[]})!=='*text*\\nComplete.' || cleanUpMessage('answer ST',false,false,true,['STOP'])!=='answer') throw Error('Cleanup settings or legacy signature failed');
  if(baseChatReplace('  card\\r\\n\\ntext  ')!=='  card\\ntext  ' || JSON.stringify(parseMesExamples('<start>literal {{user}}'))!==JSON.stringify(['<START>\\n\\n','<START>\\nliteral {{user}}\\n'])) throw Error('Card preprocessing or example parsing failed');
  let blockedMacro=false; try { baseChatReplace('<USER>'); } catch(error) { blockedMacro=error.message.includes('macro evaluation'); } if(!blockedMacro) throw Error('Unbound card macros must reject');
  if(collapseNewlines('a\\n\\nb')!=='a\\nb' || fixMarkdown('* text *',false)!=='*text*' || trimToEndSentence('完成。未完')!=='完成。') throw Error('Standalone formatting helpers failed');
  // Construct these dynamic specifiers so startup dependency discovery must
  // initialize the /script.js aliases without direct Persona/reasoning imports.
  if(scriptAvatar!=='user.png' || main_api!=='openai' || getContext().mainApi!==main_api || getCurrentChatId()!==undefined || getContext().getCurrentChatId!==getCurrentChatId) throw Error('Script state dependency initialization failed');
  if(getMaxContextTokens()!==32768 || getMaxResponseTokens()!==1024 || getMaxPromptTokens()!==31744 || getMaxContextSize!==getMaxPromptTokens || getMaxContextSize(2048)!==30720 || getMaxPromptTokens(40000)!==-7232) throw Error('Script token limit dependency initialization failed');
  const personaModule=await import('https://extension.invalid/scripts/'+'personas.js');
  const {getUserAvatars,setUserAvatar}=personaModule;
  const {extractReasoningFromData}=await import('https://extension.invalid/scripts/'+'reasoning.js');
  const {Message,MessageCollection,ChatCompletion,getChatCompletionModel,getStreamingReply,oai_settings,isImageInliningSupported,sendOpenAIRequest}=await import('https://extension.invalid/scripts/'+'openai.js');
  if(oai_settings.openai_max_context!==getMaxContextTokens() || oai_settings.openai_max_tokens!==getMaxResponseTokens()) throw Error('Shared token limits failed');
  try{oai_settings.openai_max_tokens=1;throw Error('Token limit write succeeded')}catch(error){if(!error.message.includes('write'))throw error}
  if(await getSanitizedFilename('bad/name?.txt')!=='badname.txt' || getCharaFilename(null,{manualAvatarKey:'Ada.card.png'})!=='Ada.card') throw Error('Filename helpers failed');
  if(MAX_INJECTION_DEPTH!==10000 || extension_prompt_types.NONE!==-1 || extension_prompt_roles.USER!==1 || getExtensionPromptRoleByName('assistant')!==2 || system_message_types.COMMENT!=='comment' || countOccurrences!==utilityCount || countOccurrences('aaaa','aa')!==3) throw Error('Script helpers failed');
  let lazyCalls=0; const lazy=createLazyFields({field:()=>++lazyCalls});if(lazy.field!==1 || lazy.field!==1 || lazyCalls!==1) throw Error('Lazy fields failed');
  try{download('text','file.txt');throw Error('Sandbox download succeeded')}catch(error){if(!error.message.includes('sandbox downloads'))throw error}
  try{await showFontAwesomePicker();throw Error('Default icons succeeded')}catch(error){if(!error.message.includes('default icon inventory'))throw error}
  const iconList=[['fa-user','fa-person'],['fa-star']];const iconResult=showFontAwesomePicker(iconList);iconList[0][0]='changed';
  const iconPopup=Popup.util.popups.at(-1);const iconQuery=iconPopup.content.querySelector('input');iconQuery.value='PERSON';iconQuery.dispatchEvent(new Event('input'));
  const iconButtons=iconPopup.content.querySelectorAll('.faPicker button');if(iconButtons[0].hidden || !iconButtons[1].hidden || iconButtons[0].textContent!=='fa-user') throw Error('Icon filtering failed');
  iconButtons[0].click();if(await iconResult!=='fa-user') throw Error('Icon selection failed');
  const noIconResult=showFontAwesomePicker([]);await Popup.util.popups.at(-1).completeAffirmative();if(await noIconResult!=='') throw Error('No icon result failed');
  const cancelIconResult=showFontAwesomePicker([['fa-user']]);await Popup.util.popups.at(-1).completeNegative();if(await cancelIconResult!==null) throw Error('Icon cancellation failed');
  if(extensionTypes['third-party/ui-demo']!=='local' || extensionNames.length!==1 || extensionNames[0]!=='third-party/ui-demo') throw Error('Extension identity catalog failed');
  extensionTypes['third-party/ui-demo']='changed';
  if(window.__extensionHost.modules['/scripts/extensions.js'].extensionTypes['third-party/ui-demo']!=='local') throw Error('Extension type snapshot was mutated');
  try{saveMetadataDebounced();throw Error('Unbound metadata save succeeded')}catch(error){if(!error.message.includes('saveMetadataDebounced'))throw error}
  if(world_names[0]!=='Forest' || selected_world_info[0]!=='Forest' || world_info_include_names!==false || getWorldInfoSettings().world_info_depth!==5 || world_info.charLore[0].name!=='ada') throw Error('World Info snapshot failed');
  const wiSettings=getWorldInfoSettings();wiSettings.world_info.globalSelect.length=0;
  if(getWorldInfoSettings().world_info.globalSelect[0]!=='Forest' || JSON.stringify(wiSettings).includes('must-not-enter-frame') || 'world_info_budget' in wiSettings) throw Error('World Info projection failed');
  const embedded={entries:[{keys:['forest'],content:'embedded',enabled:true,position:'before_char'}]};const converted=convertCharacterBook(embedded);
  if(newWorldInfoEntryTemplate.depth!==4 || converted.entries[0].uid!==0 || converted.entries[0].position!==0 || converted.originalData!==embedded || embedded.entries[0].id!==0) throw Error('Character book conversion failed');
  try{await saveWorldInfo('Forest',{});throw Error('World Info write succeeded')}catch(error){if(!error.message.includes('lifecycle is not bound'))throw error}
  if(getCurrentPresetName()!=='Browser preset' || getRegexedString('x',regex_placement.USER_INPUT)!=='final replacement' || getRegexScripts({allowedOnly:true}).length!==1) throw Error('Regex snapshot initialization failed');
  if(getScriptsByType(SCRIPT_TYPES.SCOPED).length!==0 || getScriptsByType(SCRIPT_TYPES.PRESET).length!==1 || getScriptsByType(SCRIPT_TYPES.PRESET,{allowedOnly:true}).length!==0) throw Error('Regex scope grants failed');
  const regexList=getRegexScripts();regexList[0].replaceString='changed';
  if(getRegexedString('x',1)!=='final replacement' || JSON.stringify(regexList).includes('must-not-enter-frame')) throw Error('Regex detached projection failed');
  if(runRegexScript({findRegex:'/(x)/g',replaceString:'[$1]',trimStrings:[],substituteRegex:0},'xx')!=='[x][x]' || RegexProvider.instance.get('/x/g').source!=='x') throw Error('Regex execution failed');
  try{allowPresetScripts('openai','Browser preset');throw Error('Regex grant succeeded')}catch(error){if(!error.message.includes('scope confirmation'))throw error}
  try{runRegexScript({findRegex:'/x/',replaceString:'{{user}}',trimStrings:[]},'x');throw Error('Unbound macro succeeded')}catch(error){if(!error.message.includes('macro context'))throw error}
  const presetManager=getPresetManager('openai');
  if(getPresetManager()!==presetManager || presetManager.getAllPresets()[0]!=='Browser preset' || presetManager.getSelectedPreset()!=='0' || presetManager.getSelectedPresetName()!=='Browser preset' || presetManager.getPresetList().settings.temp_openai!==0.8) throw Error('Preset initialization failed');
  if(presetManager.getCompletionPresetByName('Browser preset').future.keep!==true || presetManager.readPresetExtensionField({path:'demo.source'})!=='active' || getPresetManager('textgenerationwebui')!==null) throw Error('Preset read behavior failed');
  const snapshotList=presetManager.getPresetList();snapshotList.settings.extensions.demo.source='changed';
  if(presetManager.readPresetExtensionField({path:'demo.source'})!=='active') throw Error('Preset snapshot was mutated');
  if(JSON.stringify(snapshotList).includes('private.test') || JSON.stringify(snapshotList).includes('must-not-enter-frame')) throw Error('Private preset settings exposed');
  try{await presetManager.savePreset('Browser preset',{});throw Error('Preset mutation succeeded')}catch(error){if(!error.message.includes('native revision'))throw error}
  if(getChatCompletionModel()!=='browser-model' || oai_settings.custom_model!=='browser-model' || oai_settings.chat_completion_source!=='custom' || isImageInliningSupported()!==false) throw Error('OpenAI settings snapshot failed');
  try{oai_settings.custom_model='changed';throw Error('Settings write succeeded')}catch(error){if(!error.message.includes('write'))throw error}
  for(const key of ['custom_url','api_key','custom_include_headers']){try{oai_settings[key];throw Error('Private setting exposed')}catch(error){if(!error.message.includes('Unsupported'))throw error}}
  const localCompletion=new ChatCompletion(); localCompletion.setTokenBudget(100,10);
  const localMessage=await Message.createAsync('user','hello','local');
  localCompletion.add(new MessageCollection('history',localMessage));
  if(localMessage.tokens!==getTokenCount(JSON.stringify({role:'user',content:'hello'})) || localCompletion.getChat()[0].content!=='hello') throw Error('OpenAI message model failed');
  const streamState={reasoning:'',images:[],signature:null,toolSignatures:{}};
  if(getStreamingReply({choices:[{delta:{content:'reply',reasoning_content:'thought'}}]},streamState)!=='reply' || streamState.reasoning!=='thought') throw Error('Stream reply parsing failed');
  try{await sendOpenAIRequest();throw Error('Generation dispatch succeeded')}catch(error){if(!error.message.includes('native generation admission'))throw error}
  const macroCallback=()=>{throw Error('Macro callback was evaluated during registration')};
  MacrosParser.registerMacro(' frameMacro ',macroCallback,'Frame macro');
  const macroEnv={}; MacrosParser.populateEnv(macroEnv);
  if(MacrosParser.get('frameMacro')!==macroCallback || macroEnv.frameMacro!==macroCallback || [...MacrosParser][0].description!=='Frame macro' || getLastMessageId()!==null) throw Error('Legacy macro registry failed');
  MacrosParser.unregisterMacro('frameMacro');
  if(MacrosParser.has('frameMacro')) throw Error('Macro removal failed');
  if(isAdmin()!==false || getCurrentUserHandle()!=='browser-test' || accountsEnabled!==true) throw Error('Authenticated user initialization failed');
  if(NOTE_MODULE_NAME!=='2_floating_prompt' || metadata_keys.prompt!=='note_prompt' || shouldWIAddPrompt!==false || setFloatingPrompt()!==undefined) throw Error('Author note no-chat branch failed');
  if(persona_description_positions!==personaPositions || personaPositions.AT_DEPTH!==4 || send_on_enter_options.DISABLED!==-1) throw Error('Power-user enum identity failed');
  if(libraries.Bowser!==Bowser || Bowser!==window.bowser || getParsedUA().platform.type!==Bowser.parse(navigator.userAgent).platform.type || isMobile()!==['mobile','tablet'].includes(getParsedUA().platform.type)) throw Error('Device helpers failed');
  if(humanizeGenTime(61000)!=='1 Minutes, 1 Seconds' || getMessageTimeStamp(0)!=='1970-01-01T00:00:00.000Z' || humanizedDateTime(new Date(2026,0,2,3,4,5,6).getTime())!=='2026-01-02@03h04m05s006ms') throw Error('Time helpers failed');
  if(debounce_timeout.standard!==300 || IGNORE_SYMBOL!==Symbol.for('ignore') || inject_ids.DEPTH_PROMPT_INDEX(2)!=='DEPTH_PROMPT_2' || MEDIA_TYPE.getFromMime('image/png')!=='image') throw Error('Shared constants failed');
  if(personaModule.user_avatar!=='user.png' || getContext().userAvatar!==scriptAvatar || scriptAvatar!==personaModule.user_avatar || !(await getUserAvatars(false)).includes('next.png')) throw Error('Persona initialization failed');
  let personaEvent=false;
  if(name1!=='Reader' || getContext().name1!==name1 || name2!=='SillyTavern System' || getContext().name2!==name2) throw Error('Display name initialization failed');
  eventSource.on(event_types.PERSONA_CHANGED,id=>{personaEvent=id==='next.png' && personaModule.user_avatar===id && scriptAvatar===id && getContext().userAvatar===id && name1==='Next reader' && getContext().name1===name1});
  await setUserAvatar('next.png',{toastPersonaNameChange:false});
  await setUserAvatar('next.png');
  if(!personaEvent || personaModule.user_avatar!=='next.png' || scriptAvatar!=='next.png') throw Error('Persona live binding failed');
  if(extractReasoningFromData({choices:[{message:{reasoning_content:'Private thought'}}]})!=='Private thought') throw Error('Reasoning settings failed');
  if(getContext().getTokenCount!==getTokenCount || getContext().getTokenCountAsync!==getTokenCountAsync || getTokenCount('abcd',5)!==7 || await getTokenCountAsync('你好世界')!==2 || guesstimate('')!==0) throw Error('Tokenizer estimation failed');
  if(libraries.lodash!==window._ || lodash!==window._ || moment!==window.moment || lodash.get({a:{b:3}},'a.b')!==3) throw Error('Library shims failed');
  if(getContext().eventSource!==eventSource || event_types.CHAT_CHANGED!=='chat_id_changed') throw Error('Context identity failed');
  if(getContext().missingFeature!==undefined) throw Error('Feature detection failed');
  try { await import('https://extension.invalid/scripts/macros/engine/MacroRegistry.js'); throw Error('Unavailable module succeeded'); }
  catch(error) { if(!error.message.includes('Unsupported extension host module:')) throw error; }
  if(getStringHash('hello')!==4625896200565286) throw Error('Hash compatibility failed');
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"><rect width="2" height="3" fill="red"/></svg>';
  const imageSize=await getImageSizeFromDataURL('data:image/svg+xml,'+encodeURIComponent(svg));
  if(imageSize.width!==2 || imageSize.height!==3) throw Error('Image dimensions failed');
  const svgFile=new File([svg],'image.svg',{type:'image/svg+xml'});
  const pngFile=await ensureImageFormatSupported(svgFile);
  if(pngFile.type!=='image/png' || pngFile.name!=='image.svg' || (new Uint8Array(await pngFile.arrayBuffer()))[0]!==137 || await ensureImageFormatSupported(pngFile)!==pngFile) throw Error('Image conversion failed');
  addLocaleData(getCurrentLocale(), {'Hello \\u0024{0}':'Hi \\u0024{0}'});
  if(t\`Hello \${'Ada'}\`!=='Hi Ada') throw Error('Translation failed');
  const popup = new Popup('Name', POPUP_TYPE.INPUT, 'Ada');
  const result = popup.show(); popup.mainInput.value='Grace'; await popup.completeAffirmative();
  if(await result!=='Grace') throw Error('Popup result failed');
  let closeAttempts=0, closedWithDom=false;
  const custom=new Popup('Options',POPUP_TYPE.TEXT,'',{customInputs:[{id:'enabled',label:'Enabled',defaultState:true},{id:'label',label:'Label',type:'text',defaultState:'Ada'}],customButtons:['Other',{text:'Action',action:()=>{document.body.dataset.action='yes'}}],onClosing:()=>++closeAttempts>1,onClose:p=>{closedWithDom=p.dlg.isConnected}});
  const customResult=custom.show();
  await custom.completeAffirmative();
  if(custom.result!==undefined || custom.inputResults!==undefined || !custom.dlg.open) throw Error('Popup close veto failed');
  custom.dlg.querySelector('button[data-result="undefined"]').click();
  if(!custom.dlg.open || document.body.dataset.action!=='yes') throw Error('Popup action-only button failed');
  custom.dlg.querySelector('button[data-result="2"]').click();
  if(await customResult!==2 || !closedWithDom || custom.inputResults.get('enabled')!==true || custom.inputResults.get('label')!=='Ada' || Popup.util.isPopupOpen()) throw Error('Custom popup result failed');
  const inputHelper=Popup.show.input('Title','Text','');
  await Popup.util.popups.at(-1).completeNegative();
  if(await inputHelper!==null) throw Error('Input helper cancellation failed');
  const collection=new PromptCollection(new Prompt({identifier:'main'}));
  if(!collection.has('main') || getContext().Prompt!==Prompt) throw Error('Prompt module identity failed');
  SlashCommandParser.addCommandObject(SlashCommand.fromProps({name:'probe',aliases:['p'],namedArgumentList:[SlashCommandNamedArgument.fromProps({name:'enabled',typeList:ARGUMENT_TYPE.BOOLEAN})],callback:()=> 'ok'}));
  if(SlashCommandParser.commands.p!==SlashCommandParser.commands.probe || getContext().SlashCommand!==SlashCommand) throw Error('Slash registration failed');
  const lore=await loadWorldInfo('Forest');
  if(!lore.entries['9'] || lore.revision || lore.name) throw Error('World Info bridge failed');
  lore.entries['9'].content='Only a local copy';
  if((await loadWorldInfo('Forest')).entries['9'].content==='Only a local copy') throw Error('World Info read was shared or persisted');
  const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: frame\\n\\n'));c.close()}}).pipeThrough(getEventSourceStream());
  if((await stream.getReader().read()).value.data!=='frame') throw Error('SSE module failed');
  const order=[]; eventSource.on('probe',()=>order.push(2)); eventSource.makeFirst('probe',()=>order.push(1));
  await eventSource.emit('probe'); if(order.join()!=='1,2') throw Error('Listener ordering failed');
  setTimeout(()=>eventSource.on(event_types.APP_READY,()=>{document.body.dataset.lateReady='yes'}),0);
  const html=await renderExtensionTemplateAsync('ui-demo','settings',{label:'Native checkbox'});
  $('#ui-demo_container').append(html);
  let isolated=false; try{void parent.document.body}catch{isolated=true}
  let storageBlocked=false; try{void window.localStorage}catch{storageBlocked=true}
  if(!isolated || !storageBlocked || window.__SILLYTAVERN_CSRF_TOKEN__) throw Error('Isolation failed');
  $('#demo-enabled').prop('checked',extension_settings['ui-demo'].enabled).on('change',function(){extension_settings['ui-demo'].enabled=this.checked;saveSettingsDebounced()});
  $('#demo-enabled').prop('checked',true).trigger('change');
}`, 'https://extension.invalid/scripts/macros/engine/MacroRegistry.js': 'throw new Error("Unsupported extension host module: /scripts/macros/engine/MacroRegistry.js")' },
        templates: { 'settings.html': '<label>{{label}}<input id="demo-enabled" type="checkbox"></label><script>throw Error("template script ran")</script>' },
        css: ['label{display:block}'], html: '', activate: 'init',
        libraries: { jquery: fs.readFileSync(clientRequire.resolve('jquery/dist/jquery.min.js'), 'utf8'), handlebars: fs.readFileSync(clientRequire.resolve('handlebars/dist/handlebars.min.js'), 'utf8'), purify: fs.readFileSync(clientRequire.resolve('dompurify/dist/purify.min.js'), 'utf8'), lodash: fs.readFileSync(clientRequire.resolve('lodash/lodash.min.js'), 'utf8'), moment: fs.readFileSync(clientRequire.resolve('moment/min/moment.min.js'), 'utf8'), bowser: fs.readFileSync(clientRequire.resolve('bowser/bundled.js'), 'utf8') },
    };
    let preset = { kind: 'chat-completion', name: 'Browser preset', origin: 'user', revision: 'preset-1', preset: { temperature: 0.7, system_prompt: 'Original instructions', stop: ['first', 'second'], future: { keep: true } }, credentialsRedacted: false, connectionChanges: [], connectionSettings: {}, compatibilityWarnings: [] };
    const capabilities = { resources: Object.fromEntries(['session', 'characters', 'characterCreate', 'characterEdit', 'characterDelete', 'characterImport', 'characterExport', 'characterAvatar', 'personas', 'promptManager', 'presets', 'worldInfoManagement', 'macroManagement', 'regexManagement', 'chats', 'chatCreate', 'chatDelete', 'chatRename', 'chatMutate', 'chatPaging', 'chatSampling', 'renderedTranscript', 'settingsRead', 'settingsPatch', 'providerCredentials', 'providerModels', 'providerStatus', 'clientExtensionPrompts'].map(key => [key, true])), generation: Object.fromEntries(['preview', 'previewRegenerate', 'previewContinue', 'normal', 'quiet', 'regenerate', 'continue', 'cancel', 'pollingFallback', 'durableAdmission', 'discovery', 'acknowledgeUnknown'].map(key => [key, true])), features: { swipes: true, groupChats: false, toolCalling: false, images: false, personaAuthorNote: true }, auth: { csrf: false } };

    function send(method, params = {}, targetSession = session) {
        const id = ++sequence;
        return new Promise((resolve, reject) => { responses.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(targetSession ? { sessionId: targetSession } : {}) })); });
    }
    async function evaluate(expression) {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        return result.result?.value;
    }
    let inspectedTarget, inspectedSession;
    const iframeEvaluate = async expression => {
        // Inspect the frame DOM through CDP; the application retains its
        // opaque origin and cannot access the parent DOM or credentials.
        // Chrome may place an opaque sandbox in a separate process/target.
        const { targetInfos } = await send('Target.getTargets');
        const target = targetInfos.find(item => item.type === 'iframe');
        let result;
        if (target) {
            if (target.targetId !== inspectedTarget) {
                const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                inspectedTarget = target.targetId; inspectedSession = attached.sessionId;
            }
            result = await send('Runtime.evaluate', { expression, returnByValue: true }, inspectedSession);
        } else {
            const { frameTree } = await send('Page.getFrameTree');
            const frameId = frameTree.childFrames?.[0]?.frame.id;
            if (!frameId) throw Error('The extension frame is not mounted');
            const { executionContextId } = await send('Page.createIsolatedWorld', { frameId, worldName: 'extension-test-inspector' });
            result = await send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true });
        }
        if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
        return result.result?.value;
    };
    async function waitFor(expression, label = expression) {
        for (let index = 0; index < 100; index++) { if (await evaluate(`Boolean(${expression})`)) return; await delay(70); }
        throw new Error(`Timed out: ${label}\n${await evaluate('document.body.innerText.slice(-3500)')}`);
    }
    const click = async text => {
        await waitFor(`[...document.querySelectorAll('button')].some(el => el.textContent.trim() === ${JSON.stringify(text)} && !el.disabled)`, `button ${text} enabled`);
        return evaluate(`(() => { const el = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)} && !el.disabled); el.click(); })()`);
    };
    const input = (selector, value) => evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw Error('Input not found'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true})); })()`);
    async function fulfill(event, status, body) {
        try { await send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') }); }
        catch (cause) {
            // A real AbortController/unmount can cancel an interception while
            // its fixture reply is in flight. Only ignore independently
            // observed network cancellations, never unexpected route errors.
            if (cause.message === 'Invalid InterceptionId.') {
                await delay(0);
                if (cancelledRequests.has(event.networkId)) return;
            }
            throw cause;
        }
    }
    async function route(event) {
        const url = new URL(event.request.url), route = url.pathname, method = event.request.method;
        if (!route.startsWith('/api/v1/')) { violations.push(route); return fulfill(event, 500, {}); }
        const body = event.request.postData ? JSON.parse(event.request.postData) : undefined;
        requests.push({ route, method, body });
        if (route === '/api/v1/client-connection') return fulfill(event, 404, {});
        if (route === '/api/v1/package-management' && method === 'GET') return fulfill(event, 200, pluginInventory);
        if (route === '/api/v1/package-management/install' || route === '/api/v1/package-management/bulk') {
            expect(method).toBe('POST'); expect(body.expectedRevision).toBe(pluginInventory.revision); expect(body.confirmTrust).toBe(true);
            if (failPluginAction) { failPluginAction = false; return fulfill(event, 409, { error: { code: 'conflict', message: 'Inventory changed. Reload before continuing.' } }); }
            const items = route.endsWith('/install') ? [{ kind: body.kind, name: body.name }] : body.packages;
            if (route.endsWith('/install')) pluginInventory.packages.push({ kind: body.kind, name: body.name, id: body.name, manageable: true, repository: body.url });
            if (body.action === 'remove') pluginInventory.packages = pluginInventory.packages.filter(item => !items.some(target => target.kind === item.kind && target.name === item.name));
            pluginInventory.revision += '-next';
            return fulfill(event, 200, { restartRequired: true, results: items.map(item => ({ ...item, ok: !(body.action === 'upgrade' && item.kind === 'server-plugin'), message: body.action === 'upgrade' && item.kind === 'server-plugin' ? 'Working tree has local changes.' : 'Files changed.' })) });
        }
        if (route === '/api/v1/extensions') return fulfill(event, 200, [{ id: 'local/ui-demo', displayName: 'Native UI demo', runtime: 'legacy', enabled: true, compatibilityStatus: 'skipped' }]);
        if (route === '/api/v1/extensions/local%2Fui-demo/ui') return fulfill(event, 200, usePrintProbe ? printProbeBundle : useModuleProbe ? moduleProbeBundle : extensionBundle);
        if (route === '/api/v1/extensions/local%2Fui-demo/settings' && method === 'GET') return fulfill(event, 200, extensionSettings);
        if (route === '/api/v1/extensions/local%2Fui-demo/settings' && method === 'PATCH') {
            const revision = Object.entries(event.request.headers).find(([key]) => key.toLowerCase() === 'if-match')?.[1];
            expect(revision).toBe('ext-1'); expect(body).toEqual({ enabled: true });
            extensionSettings = { ...extensionSettings, revision: 'ext-2', settings: { ...extensionSettings.settings, ...body } };
            return fulfill(event, 200, extensionSettings);
        }
        if (route === '/api/v1/capabilities') return fulfill(event, 200, capabilities);
        if (route === '/api/v1/provider-status') { expect(method).toBe('GET'); return fulfill(event, 200, providerStatus); }
        if (route === '/api/v1/provider-status/check') {
            expect(method).toBe('POST'); expect(body).toEqual({});
            providerStatus = { onlineStatus: failProviderCheck ? 'no_connection' : 'Valid', state: failProviderCheck ? 'failed' : 'valid', checkedAt: Date.now() };
            return failProviderCheck ? fulfill(event, 502, { error: { code: 'provider', message: 'Model catalog unavailable.' } }) : fulfill(event, 200, providerStatus);
        }
        if (route === '/api/v1/provider-credentials') { expect(method).toBe('GET'); return fulfill(event, 200, { customConfigured: true, openaiConfigured: false }); }
        if (route === '/api/v1/session') return fulfill(event, 200, { handle: 'browser-test', userName: 'Test user', authenticated: true, accountsEnabled: true, admin: false });
        if (route === '/api/v1/settings' && method === 'GET') return fulfill(event, 200, { typed: { main_api: 'openai', power_user: { collapse_newlines: true, trim_sentences: false, auto_fix_generated_markdown: true, allow_name1_display: true, allow_name2_display: true, trim_spaces: true, user_prompt_bias: '', context: { example_separator: '---', story_string: 'must-not-enter-frame' }, api_key: 'must-not-enter-frame' }, oai_settings: { chat_completion_source: 'custom', custom_model: 'browser-model', show_thoughts: true, openai_max_context: 32768, openai_max_tokens: 1024, custom_url: 'https://private.test', api_key: 'must-not-enter-frame' } } });
        if (route === '/api/v1/characters') return fulfill(event, 200, [{ id: 'ada', name: 'Ada', avatar: 'ada.png', chatCount: 1, revision: card.revision }]);
        if (route === '/api/v1/characters/ada' && method === 'GET') return fulfill(event, 200, { ...card, avatar: 'ada.png', data: card.raw.data });
        if (route === '/api/v1/characters/ada' && method === 'PUT') {
            if (failCard) { failCard = false; return fulfill(event, 409, { error: { message: 'Card revision changed.', code: 'conflict' } }); }
            expect(body.expectedRevision).toBe('card-1'); expect(body.card.data.extensions.vendor.keep).toBe(true); expect(body.card.opaque).toEqual([1, 2]);
            card = { ...card, raw: body.card, revision: 'card-2' }; return fulfill(event, 200, card);
        }
        if (route === '/api/v1/prompt-manager' && method === 'GET') return fulfill(event, 200, prompts);
        if (route === '/api/v1/prompt-manager' && method === 'PUT') { expect(body.expectedRevision).toBe('prompt-1'); expect(body.prompts[0].future.keep).toBe(true); prompts = { ...body, revision: 'prompt-2' }; return fulfill(event, 200, prompts); }
        if (route === '/api/v1/personas' && method === 'GET') return fulfill(event, 200, personas);
        if (route === '/api/v1/personas/user.png' && method === 'PUT') { expect(body.expectedRevision).toBe('persona-1'); expect(body.description).toBe('A reader'); const { expectedRevision, ...descriptor } = body; personas = { ...personas, revision: 'persona-2', personas: [{ id: 'user.png', ...descriptor }] }; return fulfill(event, 200, personas); }
        if (route === '/api/v1/personas/user.png/select') { expect(body.expectedRevision).toBe('persona-2'); personas = { ...personas, selectedId: 'user.png', username: 'Reader', revision: 'persona-3' }; return fulfill(event, 200, personas); }
        if (route === '/api/v1/personas/next.png/select') { expect(method).toBe('POST'); expect(body).toEqual({ expectedRevision: 'persona-3' }); personas = { ...personas, selectedId: 'next.png', username: 'Next reader', revision: 'persona-4' }; return fulfill(event, 200, personas); }
        if (route === '/api/v1/world-info' && method === 'GET') return fulfill(event, 200, { books: [{ name: 'Forest', bytes: 300 }], warnings: [] });
        if (route === '/api/v1/world-info-settings' && method === 'GET') return fulfill(event, 200, { revision: 'wi-settings-1', settings: { world_info_depth: 5, world_info_include_names: false, world_info: { globalSelect: ['Forest'], charLore: [{ name: 'ada', extraBooks: ['Forest'], opaque: 'must-not-enter-frame' }] }, custom_url: 'https://private.test', api_key: 'must-not-enter-frame' } });
        if (route === '/api/v1/world-info/Forest' && method === 'GET') return fulfill(event, 200, book);
        if (route === '/api/v1/world-info/Forest' && method === 'PUT') { expect(body.expectedRevision).toBe('book-1'); expect(body.book.entries['9'].future.keep).toBe(true); expect(body.book.entries['9'].key).toEqual(['forest']); expect(body.book.extensions.keep).toBe(true); book = { ...book, book: body.book, revision: 'book-2' }; return fulfill(event, 200, book); }
        if (route === '/api/v1/presets/chat-completion' && method === 'GET') return fulfill(event, 200, { kind: 'chat-completion', activeName: preset.name, activeRevision: 'active-1', presets: [{ name: preset.name, revision: preset.revision, origin: preset.origin }], warnings: [] });
        if (route === '/api/v1/preset-settings/chat-completion' && method === 'GET') return fulfill(event, 200, { kind: 'chat-completion', name: preset.name, revision: 'active-1', preset: { temperature: 0.8, extensions: { demo: { source: 'active', api_key: 'must-not-enter-frame' }, regex_scripts: [{ findRegex: '/x/g', replaceString: 'denied', trimStrings: [], placement: [1], api_key: 'must-not-enter-frame' }] }, custom_url: 'https://private.test' } });
        for (const kind of ['context', 'instruct', 'sysprompt']) {
            if (route === `/api/v1/presets/${kind}` && method === 'GET') return fulfill(event, 200, { kind, activeName: '', activeRevision: `active-${kind}`, presets: [], warnings: [] });
            if (route === `/api/v1/preset-settings/${kind}` && method === 'GET') return fulfill(event, 200, { kind, name: '', revision: `active-${kind}`, preset: {} });
        }
        if (route === '/api/v1/presets/chat-completion/Browser%20preset' && method === 'GET') return fulfill(event, 200, preset);
        if (route === '/api/v1/presets/chat-completion/Browser%20preset' && method === 'PUT') { expect(body.expectedRevision).toBe(preset.revision); expect(body.preset.future.keep).toBe(true); preset = { ...preset, preset: body.preset, revision: 'preset-2' }; return fulfill(event, 200, preset); }
        if (route === '/api/v1/regex-settings' && method === 'GET') return fulfill(event, 200, regex);
        if (route === '/api/v1/regex-settings' && method === 'PUT') { expect(body.expectedRevision).toBe('regex-1'); expect(body.confirmScopeChanges).toBe(true); expect(body.settings.scripts[0].future).toBe(true); regex = { revision: 'regex-2', settings: body.settings }; return fulfill(event, 200, regex); }
        if (route === '/api/v1/macro-variables/global' && method === 'GET') return fulfill(event, 200, variables);
        if (route === '/api/v1/macro-variables/global' && method === 'PUT') { expect(body.expectedRevision).toBe('variables-1'); expect(body.variables.future.keep).toBe(true); variables = { revision: 'variables-2', variables: body.variables, experimental: body.experimental }; return fulfill(event, 200, variables); }
        if (route === '/api/v1/groups' && method === 'GET') return fulfill(event, 200, [team]);
        if (route === '/api/v1/groups/team' && method === 'GET') return fulfill(event, 200, team);
        if (route === '/api/v1/groups/team' && method === 'PUT') { expect(body.expectedRevision).toBe('team-1'); expect(body.group.future.keep).toBe(true); team = { ...team, revision: 'team-2', group: body.group }; return fulfill(event, 200, team); }
        if (route === '/api/v1/groups/team/chats' && method === 'GET') return fulfill(event, 200, [{ id: 'shared' }]);
        if (route === '/api/v1/groups/team/chats/shared' && method === 'GET') return fulfill(event, 200, { messages: [groupMessage], total: 1, hasMore: false });
        if (route === '/api/v1/groups/team/chats/shared/snapshot' && method === 'GET') {
            const { index: _index, ...raw } = groupMessage;
            return fulfill(event, 200, { groupId: 'team', chatId: 'shared', revision: 'b'.repeat(64), headerPresent: false, chatMetadata: {}, messages: [raw] });
        }
        if (route === '/api/v1/groups/team/chats/shared/render') return fulfill(event, 200, { messages: [groupMessage], total: 1, hasMore: false, views: [{ index: 0, display: `Display: ${groupMessage.mes}` }], warnings: [] });
        if (route === '/api/v1/groups/team/chats/shared/messages/edit') { expect(body.index).toBe(0); expect(body.expectedMessage).toEqual(groupMessage); groupMessage = { ...groupMessage, mes: body.text }; return fulfill(event, 200, { index: 0 }); }
        if (route === '/api/v1/groups/team/chats/shared/sampling' && method === 'GET') return fulfill(event, 200, groupSampling);
        if (route === '/api/v1/groups/team/chats/shared/sampling' && method === 'PUT') { expect(body.expectedRevision).toBe('sampling-1'); groupSampling = { revision: 'sampling-2', overrides: body.overrides }; return fulfill(event, 200, groupSampling); }
        if (route === '/api/v1/groups/team/chats/shared/preview') { expect(body.characterId).toBe('ada'); return fulfill(event, 200, { messages: [{ role: 'system', content: 'Group member preview' }] }); }
        if (route === '/api/v1/characters/ada/chats') return fulfill(event, 200, [{ id: 'conversation' }]);
        if (route === '/api/v1/chats/conversation/snapshot' && method === 'GET') {
            expect(url.searchParams.get('characterId')).toBe('ada');
            const { index: _index, ...raw } = message;
            return fulfill(event, 200, { characterId: 'ada', chatId: 'conversation', revision: 'a'.repeat(64), headerPresent: true, chatMetadata: { variables: { source: 'persisted' }, vendor: { keep: true } }, messages: [...Array.from({ length: 40 }, (_, index) => ({ mes: `Historical ${index}`, name: 'Ada' })), raw] });
        }
        if (route === '/api/v1/chats/conversation' && method === 'GET') {
            chatQueries.push(url.search);
            if (failPrintRead) { failPrintRead = false; return fulfill(event, 503, { error: { message: 'Transcript read failed.' } }); }
            return fulfill(event, 200, { messages: [message], total: 42, hasMore: true });
        }
        if (route === '/api/v1/chats/conversation/messages') { expect(body.index).toBe(41); expect(body.action).toBe('edit'); message = { ...message, mes: body.message.mes }; editPosts++; return fulfill(event, 200, { index: 41 }); }
        if (route === '/api/v1/generations/preview') return fulfill(event, 200, { messages: [{ role: 'system', content: 'Preview system prompt' }], warnings: { macroWarnings: [] } });
        if (route === '/api/v1/generations' && method === 'POST') {
            generationPosts++; caller = body.clientRequestId;
            const storage = await evaluate('JSON.stringify(localStorage)'); expect(storage).toContain(caller); expect(storage).not.toContain('Browser generation input');
            if (dropNext) { dropNext = false; generation = null; return send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'ConnectionReset' }); }
            generation = { requestId: `request-${generationPosts}`, clientRequestId: caller, characterId: 'ada', chatId: 'conversation', targetKind: 'character', status: body.type === 'quiet' ? 'done' : 'unknown', type: body.type, seq: 7, text: body.type === 'quiet' ? 'Quiet result' : 'Retained partial output', drained: true, committed: false, acknowledged: body.type === 'quiet', usage: { completionTokens: 2 } };
            return fulfill(event, 202, { requestId: generation.requestId, clientRequestId: caller, status: 'accepted', seq: 1 });
        }
        if (route === '/api/v1/generations' && method === 'GET') return fulfill(event, 200, { generations: generation && generation.targetKind === url.searchParams.get('targetKind') && generation.chatId === url.searchParams.get('chatId') && (!url.searchParams.has('unresolvedOnly') || !generation.acknowledged) ? [generation] : [], nextBefore: null });
        if (route === `/api/v1/generations/by-client/${caller}` && method === 'GET') return generation ? fulfill(event, 200, generation) : fulfill(event, 404, { error: { code: 'not_found', message: 'Not admitted.' } });
        if (route === `/api/v1/generations/by-client/${caller}/abandon`) { expect(body).toEqual({ characterId: 'ada', chatId: 'conversation', targetKind: 'character' }); generation = { requestId: 'abandoned', clientRequestId: caller, characterId: 'ada', chatId: 'conversation', targetKind: 'character', status: 'cancelled', seq: 2, drained: true, acknowledged: true, committed: false }; return fulfill(event, 200, generation); }
        if (/^\/api\/v1\/generations\/request-\d+$/.test(route)) return fulfill(event, 200, generation);
        if (/^\/api\/v1\/generations\/request-\d+\/acknowledge$/.test(route)) { expect(body.expectedSeq).toBe(7); generation = { ...generation, acknowledged: true }; return fulfill(event, 200, generation); }
        violations.push(`${method} ${route}`); return fulfill(event, 501, { error: { message: 'Unexpected fixture route' } });
    }

    beforeAll(async () => {
        // Exercise the real backend rewriter before loading the resulting graph
        // in the opaque frame. Handwritten virtual URLs bypass this boundary.
        const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-module-probe-'));
        try {
            const directory = path.join(snapshotRoot, 'ui-demo'); fs.mkdirSync(directory);
            fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ js: 'index.js', activate: 'init' }));
            fs.writeFileSync(path.join(directory, 'index.js'), `
                import { getStringHash } from "../../../utils.js";
                import { cleanUpMessage, baseChatReplace, parseMesExamples, saveChatConditional, saveChat, saveMetadata } from "../../../../script.js";
                import { saveCharacterDebounced, getThumbnailUrl, getCharacterCardFields, messageFormatting, addOneMessage, setExtensionPrompt, reloadMarkdownProcessor, showSwipeButtons, setGenerationProgress, setUserName, scrollChatToBottom, clearChat, reloadCurrentChat, deleteCharacter, getCharacters, getOneCharacter, getPastCharacterChats, printCharacters, selectCharacterById } from "../../../../script.js";
                import { substituteParams, substituteParamsExtended, extractMessageBias, getBiasStrings, unshallowCharacter, stopGeneration, eventSource, event_types, DEFAULT_SAVE_EDIT_TIMEOUT, DEFAULT_PRINT_TIMEOUT } from "../../../../script.js";
                import { characters, this_chid, getCurrentChatId, chat, chat_metadata } from "../../../../script.js";
                import { getContext } from "../../../extensions.js";
                import value, { marker } from './child.js';
                export { marker } from "./child.js";
                export * from './bridge.js';
                export async function init() {
                    if (this_chid !== undefined || getCurrentChatId() !== undefined || characters.length !== 1 || characters[0].avatar !== 'ada.png' || characters[0].data.extensions.vendor.keep !== true || !Object.isFrozen(characters[0].data)) throw Error('Native character catalog settings snapshot differs');
                    if (getContext().characters !== characters || getContext().characterId !== this_chid || getContext().chatId !== undefined) throw Error('Catalog context aliases differ');
                    if (getContext().chat !== chat || getContext().chatMetadata !== chat_metadata || chat.length !== 0 || Object.keys(chat_metadata).length !== 0 || !Object.isFrozen(chat_metadata)) throw Error('No-selection chat state differs');
                    if (await unshallowCharacter(0) !== undefined || await unshallowCharacter('missing') !== undefined) throw Error('Fully loaded catalog should not fetch shallow cards');
                    for (const [name, save] of Object.entries({ saveChatConditional, saveChat, saveMetadata })) {
                        if (getContext()[name] !== (name === 'saveChat' ? saveChatConditional : save)) throw Error('Chat save context alias differs: ' + name);
                        const attempt = save();
                        if (!(attempt instanceof Promise)) throw Error('Chat save must return a promise: ' + name);
                        try { await attempt; throw Error('Unbound chat save succeeded'); }
                        catch (error) { if (!error.message.includes('transcript persistence lifecycle are not bound')) throw error; }
                    }
                    const synchronous = { saveCharacterDebounced, getThumbnailUrl, getCharacterCardFields, messageFormatting, addOneMessage, setExtensionPrompt, reloadMarkdownProcessor, showSwipeButtons, setGenerationProgress, setUserName, scrollChatToBottom };
                    for (const [name, method] of Object.entries(synchronous)) {
                        try { method(); throw Error('Unbound native operation succeeded'); }
                        catch (error) { if (!error.message.includes(name) || !error.message.includes('not bound')) throw error; }
                    }
                    const asynchronous = { clearChat, reloadCurrentChat, deleteCharacter, getCharacters, getOneCharacter, getPastCharacterChats, printCharacters, selectCharacterById };
                    for (const [name, method] of Object.entries(asynchronous)) {
                        try { await method(); throw Error('Unbound native operation succeeded'); }
                        catch (error) { if (!error.message.includes(name) || !error.message.includes('not bound')) throw error; }
                    }
                    if (getContext().saveCharacterDebounced !== saveCharacterDebounced || getContext().unshallowCharacter !== unshallowCharacter || getContext().stopGeneration !== stopGeneration || getContext().substituteParams !== substituteParams || getContext().substituteParamsExtended !== substituteParamsExtended) throw Error('New script context alias differs');
                    if (substituteParams(42) !== '42' || substituteParamsExtended('  literal  ') !== '  literal  ' || DEFAULT_SAVE_EDIT_TIMEOUT !== 1000 || DEFAULT_PRINT_TIMEOUT !== 100) throw Error('Literal substitution or source timeout constants differ');
                    try { substituteParams('{{user}}'); throw Error('Unbound native macro succeeded'); }
                    catch (error) { if (!error.message.includes('macro evaluation context is not bound')) throw error; }
                    if (extractMessageBias('{{bias "first"}} text {{bias "second"}}') !== ' first second' || getBiasStrings('ignored', 'continue').isUserPromptBias !== false) throw Error('Bias helper behavior differs');
                    if (await unshallowCharacter() !== undefined) throw Error('Undefined character-ID branch returned data');
                    let stopped = 0; const onStopped = () => { stopped++; };
                    eventSource.on(event_types.GENERATION_STOPPED, onStopped);
                    if (stopGeneration() !== false || stopped !== 1) throw Error('Frame-local stop branch differs');
                    eventSource.off(event_types.GENERATION_STOPPED, onStopped);
                    const lazy = await import(\`./lazy.mjs\`);
                    const utils = await import('../../../utils.js');
                    if (value !== 42 || marker !== 'module-probe' || !lazy.ready || utils.getStringHash !== getStringHash) throw Error('Rewritten module graph failed');
                    if (cleanUpMessage({ getMessage: '  probe ST', stoppingStrings: ['STOP'] }) !== 'probe') throw Error('Root-only cleanup dependency initialization failed');
                    if (baseChatReplace('card\\r\\n\\ntext') !== 'card\\ntext' || parseMesExamples('example')[0] !== '<START>\\nexample\\n') throw Error('Root-only card/example dependency initialization failed');
                    // Self-messaging uses '*' for an opaque origin. Never pass
                    // location.origin ('null') as a postMessage target.
                    await new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => reject(Error('Self-message was not delivered')), 3000);
                        const receive = event => {
                            if (event.source !== window || event.data !== marker) return;
                            clearTimeout(timeout); window.removeEventListener('message', receive); resolve();
                        };
                        window.addEventListener('message', receive);
                        window.postMessage(marker, '*');
                    });
                    document.getElementById('extensions_settings').dataset.moduleProbe = 'passed';
                }
            `);
            fs.writeFileSync(path.join(directory, 'child.js'), 'export default 42; export const marker = "module-probe";');
            fs.writeFileSync(path.join(directory, 'bridge.js'), 'export { default as value } from "./child.js";');
            fs.writeFileSync(path.join(directory, 'lazy.mjs'), 'export const ready = true;');
            moduleProbeBundle = await readExtensionUi({ directories: { extensions: snapshotRoot } }, 'local/ui-demo');
            fs.writeFileSync(path.join(directory, 'index.js'), `
                import { printMessages, activateSendButtons, deactivateSendButtons, characters, this_chid, getCurrentChatId, chat, chat_metadata, name1, name2, is_send_press, isGenerating, extension_prompts, setExtensionPrompt } from "../../../../script.js";
                import { getLastMessageId } from "../../../macros.js";
                import getContext from "../../../st-context.js";
                export function init() {
                    const state = document.createElement('output'); state.id = 'selection-result';
                    state.textContent = JSON.stringify({ characterId: this_chid, groupId: getContext().groupId, chatId: getCurrentChatId(), avatar: characters[this_chid]?.avatar, selectedChat: characters[this_chid]?.chat, chatLength: chat.length, metadataVariable: chat_metadata.variables?.source, name1, name2 });
                    document.body.append(state);
                    if (getContext().characters !== characters || getContext().characterId !== this_chid || getContext().chatId !== getCurrentChatId()) throw Error('Bound selection context aliases differ');
                    if (getContext().name1 !== name1 || getContext().name2 !== name2) throw Error('Display name context aliases differ');
                    if (getContext().chat !== chat || getContext().chatMetadata !== chat_metadata || !Object.isFrozen(chat) || !Object.isFrozen(chat_metadata) || getLastMessageId() !== (chat.length ? chat.length - 1 : null)) throw Error('Complete transcript context aliases or indexes differ');
                    if (getContext().printMessages !== printMessages) throw Error('printMessages context identity failed');
                    if (getContext().activateSendButtons !== activateSendButtons || getContext().deactivateSendButtons !== deactivateSendButtons) throw Error('Send controls context identity failed');
                    const sendOutput = document.createElement('output'); sendOutput.id = 'send-result';
                    for (const [name, action] of Object.entries({ disable: deactivateSendButtons, enable: activateSendButtons })) {
                        const sendButton = document.createElement('button'); sendButton.id = 'send-' + name; sendButton.textContent = name;
                        sendButton.onclick = async () => {
                            sendOutput.textContent = 'pending';
                            try { if (await action() !== undefined) throw Error('Send controls leaked native state'); sendOutput.textContent = name; }
                            catch (error) { sendOutput.textContent = error.message; }
                        };
                        document.body.append(sendButton);
                    }
                    document.body.append(sendOutput);
                    if(getContext().extensionPrompts!==extension_prompts || getContext().setExtensionPrompt!==setExtensionPrompt) throw Error('Prompt registry context identity differs');
                    const promptOutput=document.createElement('output'); promptOutput.id='prompt-result';
                    for(const action of ['inject','remove','fail']) {
                        const button=document.createElement('button'); button.id='prompt-'+action;
                        button.onclick=()=>{
                            try {
                                if(action==='remove') { delete extension_prompts.browser; delete extension_prompts.filtered; }
                                else {
                                    setExtensionPrompt('browser','Browser injection',1,3,true,2,async()=>{if(action==='fail')throw Error('Browser predicate failure');return true;});
                                    setExtensionPrompt('filtered','Filtered injection',1,0,false,0,()=>false);
                                }
                                promptOutput.textContent=action;
                            }catch(error){promptOutput.textContent=error.message;}
                        };
                        document.body.append(button);
                    }
                    document.body.append(promptOutput);
                    const generationOutput = document.createElement('output'); generationOutput.id = 'generation-result';
                    const generationButton = document.createElement('button'); generationButton.id = 'read-generation';
                    generationButton.onclick = () => { generationOutput.textContent = JSON.stringify({ pressed: is_send_press, generating: isGenerating(), context: getContext().isGenerating() }); };
                    document.body.append(generationButton, generationOutput);
                    const button = document.createElement('button'); button.id = 'print-probe'; button.textContent = 'Print messages';
                    const output = document.createElement('output'); output.id = 'print-result';
                    let count = 0;
                    button.onclick = async () => {
                        output.textContent = 'pending';
                        try {
                            const result = await (++count % 2 ? printMessages() : getContext().printMessages());
                            if (result !== undefined) throw Error('printMessages leaked a result');
                            output.textContent = 'done';
                        } catch (error) { output.textContent = error.message; }
                    };
                    document.body.append(button, output);
                }
            `);
            printProbeBundle = await readExtensionUi({ directories: { extensions: snapshotRoot } }, 'local/ui-demo');
        } finally { fs.rmSync(snapshotRoot, { recursive: true, force: true }); }
        const reserved = net.createServer(); await new Promise((resolve, reject) => { reserved.once('error', reject); reserved.listen(0, '127.0.0.1', resolve); }); port = reserved.address().port; await new Promise(resolve => reserved.close(resolve));
        const development = process.env.CLIENT_BROWSER_DEV === '1';
        web = spawn(process.execPath, [clientRequire.resolve('next/dist/bin/next'), development ? 'dev' : 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: path.resolve('client'), env: { ...process.env, NEXT_DIST_DIR: development ? '.next-browser-dev' : '.next-build' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let ready = false, output = ''; web.stdout.on('data', chunk => { output += chunk; if (output.includes('Ready in')) ready = true; }); web.stderr.on('data', chunk => { output += chunk; });
        for (let index = 0; index < 100 && !ready && web.exitCode === null; index++) await delay(100);
        if (!ready) throw new Error(`Next did not start: ${output.slice(-1500)}`);
        profile = fs.mkdtempSync(path.join(os.tmpdir(), 'st-client-browser-'));
        chrome = spawn(process.env.CHROME_BIN || '/opt/google/chrome/chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
        const debuggerUrl = await new Promise((resolve, reject) => { let log = ''; const timer = setTimeout(() => reject(new Error(`Chrome startup failed: ${log.slice(-1000)}`)), 10_000); chrome.once('error', reject); chrome.stderr.on('data', chunk => { log += chunk; const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } }); });
        socket = new WebSocket(debuggerUrl); await new Promise(resolve => socket.once('open', resolve));
        socket.on('message', raw => { const event = JSON.parse(String(raw)); if (event.id) { const pending = responses.get(event.id); responses.delete(event.id); if (event.error) pending?.reject(new Error(event.error.message)); else pending?.resolve(event.result); } else listeners.get(event.method)?.(event.params); });
        const target = await send('Target.createTarget', { url: 'about:blank' }, null); const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null); session = attached.sessionId;
        listeners.set('Fetch.requestPaused', event => { void route(event).catch(async e => { violations.push(e.message); await fulfill(event, 500, { error: { message: e.message } }); }); });
        listeners.set('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text));
        listeners.set('Network.loadingFailed', event => { if (event.canceled) cancelledRequests.add(event.requestId); });
        listeners.set('Runtime.consoleAPICalled', event => {
            const message = event.args.map(arg => arg.value ?? arg.description ?? '').join(' ');
            if (event.type === 'error' && /hydrat|server rendered HTML/i.test(message)) hydrationErrors.push(message);
        });
        listeners.set('Page.javascriptDialogOpening', () => { void send('Page.handleJavaScriptDialog', { accept: true }); });
        await send('Page.enable'); await send('Runtime.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
        await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1050, deviceScaleFactor: 1, mobile: false });
        await send('Network.enable');
        await send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } });
        // Simulate extension content scripts adding attributes during HTML parsing,
        // before React hydrates. Only inject into the top-level document.
        await send('Page.addScriptToEvaluateOnNewDocument', { source: `
            if (window === window.top) {
                const observer = new MutationObserver(() => {
                    if (!document.body) return;
                    document.body.setAttribute('data-new-gr-c-s-check-loaded', '14.1350.0');
                    document.body.setAttribute('data-gr-ext-installed', '');
                    observer.disconnect();
                });
                observer.observe(document, { childList: true, subtree: true });
            }
        ` });
        await send('Page.navigate', { url: `http://127.0.0.1:${port}` });
    }, 30_000);
    afterAll(async () => {
        socket?.close(); chrome?.kill('SIGTERM'); web?.kill('SIGTERM');
        if (chrome && chrome.exitCode === null) await new Promise(resolve => { const timer = setTimeout(resolve, 1500); chrome.once('exit', () => { clearTimeout(timer); resolve(); }); });
        if (profile) fs.rmSync(profile, { recursive: true, force: true });
    });

    test('hydrates with extension-injected body attributes and serves the client favicon', async () => {
        await waitFor("document.querySelector('[role=dialog]')");
        expect(await evaluate("document.body.getAttribute('data-new-gr-c-s-check-loaded')")).toBe('14.1350.0');
        expect(await evaluate("document.body.hasAttribute('data-gr-ext-installed')")).toBe(true);
        const favicon = await evaluate(`(async () => {
            const response = await fetch('/favicon.ico');
            return { status: response.status, type: response.headers.get('content-type'), header: [...new Uint8Array(await response.arrayBuffer()).slice(0, 4)] };
        })()`);
        expect(favicon.status).toBe(200);
        expect(favicon.type).toMatch(/^image\/(?:x-icon|vnd.microsoft.icon)/);
        expect(favicon.header).toEqual([0, 0, 1, 0]);
        expect(await evaluate("!!document.querySelector('link[rel=icon][href^=\"/favicon.ico\"]')")).toBe(true);
        expect(hydrationErrors).toEqual([]);
        expect(errors).toEqual([]);
    }, 30_000);

    test('edits inspected resources, preserves failed drafts, uses server indexes and recovers unknown outcomes without replay', async () => {
        await waitFor("document.querySelector('[role=dialog]')");
        await input('.connect-modal .language-switcher select', 'zh-CN');
        await waitFor("document.documentElement.lang === 'zh-CN' && document.querySelector('#connect-title')?.textContent.includes('连接 SillyTavern')");
        expect(await evaluate("document.querySelector('.connect-modal select').getAttribute('aria-label')")).toBe('语言');
        await input('.connect-modal .language-switcher select', 'en-US');
        await waitFor("document.documentElement.lang === 'en-US'");
        await input('.connect-modal input', `http://127.0.0.1:${port}`); await click('Verify & connect');
        await waitFor("document.body.innerText.includes('API settings') && !document.querySelector('[role=dialog]')");
        expect(await evaluate("document.body.innerText.includes('Groups')")).toBe(false);
        await click('Character cards'); await waitFor("document.querySelector('.preset-list .preset-item')"); await evaluate("document.querySelector('.preset-list .preset-item').click()");
        await waitFor("document.querySelector('.resource-fields textarea')?.value === 'Original'");
        await input('.resource-fields textarea', 'Edited character'); await click('Save');
        await waitFor("document.querySelector('[role=alert]')?.textContent.includes('Card revision changed')");
        expect(await evaluate("document.querySelector('.resource-fields textarea').value")).toBe('Edited character');
        expect(requests.filter(item => item.route === '/api/v1/characters/ada' && item.method === 'PUT')).toHaveLength(1);
        const failedDraftRequests = requests.length;
        await input('.top-actions .language-switcher select', 'zh-CN');
        await waitFor("document.querySelector('[role=alert]')?.textContent.includes('草稿已保留')");
        expect(await evaluate("document.querySelector('[role=alert]').textContent")).toContain('Card revision changed.');
        expect(await evaluate("document.querySelector('.resource-fields textarea').value")).toBe('Edited character');
        expect(requests).toHaveLength(failedDraftRequests);
        await input('.top-actions .language-switcher select', 'en-US');
        await waitFor("document.querySelector('[role=alert]')?.textContent.includes('Draft retained')");
        await click('Save'); await waitFor("document.querySelector('[role=status]')?.textContent.includes('Saved')");
        expect(card.raw.data.description).toBe('Edited character');

        await click('Prompt Manager'); await waitFor("document.querySelectorAll('.prompt-entry').length === 2");
        await evaluate("document.querySelector('.prompt-entry').open=true"); await click('Move down'); await click('Save');
        await waitFor("document.querySelector('[role=status]')?.textContent.includes('Saved')"); expect(prompts.order[0].identifier).toBe('history');

        await evaluate("document.querySelector('.character-row').click()"); await waitFor("document.querySelector('.chat-picker .preset-item')"); await click('conversation');
        await waitFor("document.querySelector('.transcript-row')?.textContent.includes('Original reply')"); await click('Edit raw');
        await input('.transcript-row textarea', 'Edited reply'); await click('Save message');
        await waitFor("document.querySelector('.message-text')?.textContent === 'Edited reply'"); expect(editPosts).toBe(1);
        await input('.generation-composer textarea', 'Browser generation input'); await click('Preview');
        await waitFor("document.body.innerText.includes('Preview system prompt')"); expect(generationPosts).toBe(0);
        await click('Generate'); await waitFor("document.body.innerText.includes('Retained partial output') && !document.body.innerText.includes('Observing…')");
        expect(generationPosts).toBe(1);
        expect(await evaluate("[...document.querySelectorAll('button')].find(el=>el.textContent==='Generate').disabled")).toBe(true);
        await evaluate("document.querySelector('.generation-observation input[type=checkbox]').click()"); await click('Acknowledge inspected outcome');
        await input('.generation-composer textarea', 'Ready after acknowledgement');
        await waitFor("![...document.querySelectorAll('button')].find(el=>el.textContent==='Generate').disabled"); expect(generationPosts).toBe(1);
        await input('.generation-composer select', 'quiet'); await input('.generation-composer textarea', ''); await click('Generate');
        await waitFor("document.body.innerText.includes('Quiet result') && !document.body.innerText.includes('Observing…')");
        expect(generationPosts).toBe(2); expect(await evaluate("document.body.innerText.includes('no transcript row was committed')")).toBe(true);

        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await waitFor('document.documentElement.scrollWidth <= window.innerWidth');
        await waitFor("document.querySelector('.sidebar').getBoundingClientRect().right <= 0");
        await evaluate("document.querySelector('[aria-label=\"Open navigation\"]').click()");
        await waitFor("document.querySelector('[aria-label=\"Open navigation\"]').getAttribute('aria-expanded') === 'true'");
        expect(await evaluate("document.querySelector('.main-area').inert")).toBe(true);
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await waitFor("document.querySelector('.sidebar').getBoundingClientRect().right <= 0");
        expect(await evaluate("document.querySelector('.main-area').inert")).toBe(false);
        if (process.env.CLIENT_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CLIENT_SCREENSHOT_DIR, { recursive: true }); const image = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.env.CLIENT_SCREENSHOT_DIR, 'client-mobile.png'), Buffer.from(image.data, 'base64')); }
        expect(violations).toEqual([]); expect(errors).toEqual([]);
    }, 40_000);

    test('edits Personas and native World Info, and requires a separate regex scope grant', async () => {
        await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1050, deviceScaleFactor: 1, mobile: false });
        await click('Personas'); await waitFor("document.querySelector('.preset-list .preset-item')"); await evaluate("document.querySelector('.preset-list .preset-item').click()");
        await waitFor("document.querySelector('.resource-fields input')?.value === 'Reader'");
        await input('.resource-fields input', 'Reader renamed'); await click('Save'); await waitFor("document.querySelector('[role=status]')?.textContent.includes('Saved')");
        await click('Select persona'); await waitFor("document.querySelector('[role=status]')?.textContent.includes('selected')"); expect(personas.selectedId).toBe('user.png');
        await click('World Info books'); await waitFor("document.querySelector('.preset-list .preset-item')"); await evaluate("document.querySelector('.preset-list .preset-item').click()");
        await waitFor("document.querySelector('.world-entries .prompt-entry')"); await evaluate("document.querySelector('.world-entries .prompt-entry').open=true");
        // The two textareas have separate labels; select the Content field explicitly.
        await evaluate("(() => { const label=[...document.querySelectorAll('.world-entries label')].find(el=>el.firstChild?.textContent.trim()==='Content'); const el=label.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Changed lore'); el.dispatchEvent(new Event('input',{bubbles:true})); })()");
        await click('Save'); await waitFor("document.querySelector('[role=status]')?.textContent.includes('Saved')"); expect(book.book.entries['9'].content).toBe('Changed lore');
        await click('Regex scripts'); await waitFor("document.querySelector('textarea[aria-label=\"Find Regex\"]')");
        await evaluate("document.querySelectorAll('.document-editor details').forEach(el => el.open=true)");
        await input('textarea[aria-label="Replace String"]', 'replacement from fields');
        await click('JSON'); await waitFor("document.querySelector('textarea[aria-invalid]')");
        expect(await evaluate("JSON.parse(document.querySelector('textarea[aria-invalid]').value).settings.scripts[0].replaceString")).toBe('replacement from fields');
        await input('textarea[aria-invalid]', '{broken');
        expect(await evaluate("document.querySelector('textarea[aria-invalid]').getAttribute('aria-invalid')")).toBe('true');
        await input('textarea[aria-invalid]', JSON.stringify({ settings: { ...regex.settings, scripts: [{ ...regex.settings.scripts[0], replaceString: 'replacement from fields' }], characterAllowed: ['ada.png'] } }));
        expect(requests.filter(item => item.route === '/api/v1/regex-settings' && item.method === 'PUT')).toHaveLength(0);
        const grantSelector = '.resource-warning input[type=checkbox]';
        expect(await evaluate(`document.querySelector('${grantSelector}').checked`)).toBe(false);
        await evaluate(`document.querySelector('${grantSelector}').click()`);
        await click('Fields'); await evaluate("document.querySelectorAll('.document-editor details').forEach(el => el.open=true)");
        await input('textarea[aria-label="Replace String"]', 'final replacement');
        expect(await evaluate(`document.querySelector('${grantSelector}').checked`)).toBe(false);
        await evaluate(`document.querySelector('${grantSelector}').click()`); await click('Save'); await waitFor("document.querySelector('[role=status]')?.textContent.includes('Saved')");
        expect(regex.settings.characterAllowed).toEqual(['ada.png']); expect(regex.settings.scripts[0].replaceString).toBe('final replacement');
        await click('Global variables'); await waitFor("document.querySelector('.document-editor input[type=checkbox]')");
        await evaluate("document.querySelectorAll('.document-editor details').forEach(el => el.open=true)");
        await input('textarea[aria-label="Count"]', '2');
        await evaluate("document.querySelector('.document-editor input[type=checkbox]').click()"); await click('Save');
        await waitFor("document.querySelector('[role=status]')?.textContent.includes('Saved')"); expect(variables.experimental).toBe(false); expect(variables.variables.count).toBe('2');
        if (process.env.CLIENT_SCREENSHOT_DIR) { const image = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.env.CLIENT_SCREENSHOT_DIR, 'client-editor-desktop.png'), Buffer.from(image.data, 'base64')); }
        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await waitFor('document.documentElement.scrollWidth <= window.innerWidth');
        await waitFor("document.querySelector('.sidebar').getBoundingClientRect().right <= 0");
        if (process.env.CLIENT_SCREENSHOT_DIR) { const image = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.env.CLIENT_SCREENSHOT_DIR, 'client-editor-mobile.png'), Buffer.from(image.data, 'base64')); }
        await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1050, deviceScaleFactor: 1, mobile: false });
        expect(violations).toEqual([]); expect(errors).toEqual([]);
    }, 30_000);

    test('a lost admission response can be inspected and abandoned without a second generation POST', async () => {
        await evaluate("document.querySelector('.character-row').click()"); await waitFor("document.querySelector('.chat-picker .preset-item')"); await click('conversation'); await waitFor("document.querySelector('.generation-composer textarea')");
        dropNext = true; await input('.generation-composer textarea', 'Lost response input'); await click('Generate');
        await waitFor("document.body.innerText.includes('Inspect caller ID')"); expect(generationPosts).toBe(3);
        await click('Inspect caller ID'); await waitFor("document.body.innerText.includes('Permanently abandon key')");
        await click('Permanently abandon key');
        await waitFor("![...document.querySelectorAll('button')].some(el=>el.textContent==='Inspect caller ID')");
        expect(generationPosts).toBe(3); expect(await evaluate("document.querySelector('.generation-composer textarea').value")).toBe('Lost response input');
    }, 20_000);

    test('edits preset values and array order in Fields without activating the preset', async () => {
        await click('Presets'); await waitFor("document.querySelector('input[aria-label=\"Temperature\"]')");
        await input('input[aria-label="Temperature"]', '0.9');
        await input('textarea[aria-label="System prompt"]', 'Updated instructions\nSecond line');
        await evaluate("document.querySelectorAll('.preset-editor details').forEach(el => el.open=true)");
        await evaluate("document.querySelector('[aria-label=\"Move Item 2 up\"]').click()");
        await click('JSON'); await waitFor("document.querySelector('textarea[aria-invalid]')");
        expect(await evaluate("JSON.parse(document.querySelector('textarea[aria-invalid]').value).stop")).toEqual(['second', 'first']);
        await click('Fields');
        // Add a third string through the array's visual controls.
        await evaluate("(() => { const section=[...document.querySelectorAll('.preset-editor details')].find(el => el.querySelector('summary')?.textContent.startsWith('Stop')); section.open=true; [...section.querySelectorAll('button')].find(el => el.textContent === '+ Add item').click(); })()");
        await click('Add item'); await input('textarea[aria-label="Item 3"]', 'third');
        await evaluate("document.querySelector('[aria-label=\"Remove Item 1\"]').click()");
        await click('Save changes'); await waitFor("document.querySelector('[role=status]')?.textContent.includes('Preset saved')");
        expect(preset.preset.temperature).toBe(0.9); expect(preset.preset.system_prompt).toBe('Updated instructions\nSecond line');
        expect(preset.preset.stop).toEqual(['first', 'third']); expect(preset.preset.future.keep).toBe(true);
        expect(requests.filter(item => item.route.endsWith('/activate'))).toHaveLength(0);
        expect(violations).toEqual([]); expect(errors).toEqual([]);
    }, 20_000);

    test('uses granular group resources and raw expected rows even for headerless rendered chats', async () => {
        Object.assign(capabilities.resources, Object.fromEntries(['groups', 'groupManagement', 'groupChatPaging', 'groupChatRender', 'groupChatPreview', 'groupChatMessageEdit', 'groupChatSampling'].map(key => [key, true])));
        await evaluate("document.querySelector('[aria-label=\"API connection\"]').click()"); await waitFor("document.querySelector('[role=dialog]')"); await click('Verify & connect');
        await waitFor("!document.querySelector('[role=dialog]')"); await click('Groups'); await waitFor("document.querySelector('.preset-list .preset-item:not(:disabled)')"); await evaluate("document.querySelector('.preset-list .preset-item:not(:disabled)').click()");
        await waitFor("document.querySelector('.resource-fields input')?.value==='Team'"); await input('.resource-fields input', 'Team renamed'); await click('Save'); await waitFor("document.querySelector('[role=status]')?.textContent.includes('Saved')");
        await click('Open chats'); await waitFor("document.querySelector('.chat-picker .preset-item')"); await click('shared'); await waitFor("document.querySelector('.message-text')?.textContent==='Group raw'");
        await waitFor("[...document.querySelectorAll('label')].find(el=>el.textContent.trim()==='Display projection')?.querySelector('input:not(:disabled)')");
        await evaluate("[...document.querySelectorAll('label')].find(el=>el.textContent.trim()==='Display projection').querySelector('input').click()");
        await waitFor("document.querySelector('.message-text')?.textContent==='Display: Group raw'"); await click('Edit raw');
        expect(await evaluate("document.querySelector('.transcript-row textarea').value")).toBe('Group raw'); await input('.transcript-row textarea', 'Group changed'); await click('Save message');
        await waitFor("document.querySelector('.message-text')?.textContent==='Display: Group changed'");
        await click('Sampling'); await waitFor("document.querySelector('input[aria-label=\"Temperature\"]')"); await evaluate("document.querySelectorAll('.document-editor details').forEach(el => el.open=true)"); await input('input[aria-label="Temperature"]', '0.8'); await click('Save');
        await waitFor("document.querySelector('[role=status]')?.textContent.includes('Saved')"); expect(groupSampling.overrides.temperature).toBe(0.8);
        await click('Preview'); await waitFor("document.body.innerText.includes('Group member preview')");
        expect(generationPosts).toBe(3); expect(capabilities.features.groupChats).toBe(false); expect(violations).toEqual([]); expect(errors).toEqual([]);
    }, 30_000);

    test('loads extension-owned modules and sanitized templates in an isolated frame with scoped revision-checked saves', async () => {
        personas.personas.push({ ...personas.personas[0], id: 'next.png', name: 'Next reader' });
        const bookBefore = JSON.stringify(book);
        const worldReadsBefore = requests.filter(item => item.route === '/api/v1/world-info/Forest' && item.method === 'GET').length;
        Object.assign(capabilities.resources, { extensions: true, extensionSettings: true, extensionUi: true });
        await evaluate("document.querySelector('[aria-label=\"API connection\"]').click()"); await waitFor("document.querySelector('[role=dialog]')"); await click('Verify & connect');
        await waitFor("!document.querySelector('[role=dialog]')"); await click('Extensions');
        await waitFor("[...document.querySelectorAll('.preset-item span')].some(el=>el.textContent==='Native UI demo')");
        await evaluate("[...document.querySelectorAll('.preset-item')].find(el=>el.querySelector('span')?.textContent==='Native UI demo').click()");
        expect(await evaluate("document.querySelector('iframe')")).toBeNull();
        expect(requests.filter(item => item.route.endsWith('/ui'))).toHaveLength(0);
        await click('Load extension UI');
        await waitFor("document.body.innerText.includes('Extension modules loaded.')");
        for (let i = 0; i < 100 && extensionSettings.revision !== 'ext-2'; i++) await delay(70);
        expect(extensionSettings.settings.enabled).toBe(true);
        expect(extensionSettings.settings.opaque).toEqual({ keep: true });
        expect(await evaluate("document.querySelector('iframe').getAttribute('sandbox')")).toBe('allow-scripts');
        expect(await evaluate("document.querySelector('[role=alert]')?.textContent ?? ''")).toBe('');
        expect(requests.filter(item => item.route.endsWith('/settings') && item.method === 'PATCH' && item.route.includes('/extensions/'))).toHaveLength(1);
        expect(requests.filter(item => item.route === '/api/v1/world-info/Forest' && item.method === 'GET')).toHaveLength(worldReadsBefore + 2);
        expect(JSON.stringify(book)).toBe(bookBefore);
        const checkCount = requests.filter(item => item.route === '/api/v1/provider-status/check').length;
        const waitStatus = async value => {
            for(let i=0;i<120;i++) {
                const state=JSON.parse(await iframeEvaluate("document.querySelector('#online-status').textContent"));
                if(state.value===value) return state;
                await delay(70);
            }
            throw Error('Native online_status did not update');
        };
        expect(await waitStatus('no_connection')).toEqual({value:'no_connection',context:'no_connection',events:[]});
        providerStatus = { onlineStatus: 'Valid', state: 'valid', checkedAt: Date.now() };
        expect(await waitStatus('Valid')).toEqual({value:'Valid',context:'Valid',events:['Valid']});
        providerStatus = { onlineStatus: 'no_connection', state: 'unchecked', checkedAt: null };
        expect(await waitStatus('no_connection')).toEqual({value:'no_connection',context:'no_connection',events:['Valid','no_connection']});
        expect(requests.filter(item => item.route === '/api/v1/provider-status/check')).toHaveLength(checkCount);
        expect(personas.selectedId).toBe('next.png');
        expect(requests.filter(item => item.route === '/api/v1/personas/next.png/select')).toHaveLength(1);
        expect(violations).toEqual([]); expect(errors).toEqual([]);
    }, 20_000);

    test('loads backend-rewritten static, reexport and dynamic imports in the opaque extension frame', async () => {
        useModuleProbe = true;
        try {
            await click('Reload extension UI');
            await waitFor("document.body.innerText.includes('Extension modules loaded.')");
            expect(await evaluate("document.querySelector('[role=alert]')?.textContent ?? ''")).toBe('');
            expect(await evaluate("document.querySelector('iframe').getAttribute('sandbox')")).toBe('allow-scripts');
            expect(await evaluate("document.querySelectorAll('iframe').length")).toBe(1);
            expect(violations).toEqual([]); expect(errors).toEqual([]);
        } finally { useModuleProbe = false; }
    }, 20_000);

    test('printMessages redraws the bound native conversation and session-scoped send controls preserve fences and drafts', async () => {
        usePrintProbe = true;
        const waitOutput = async text => {
            for (let i = 0; i < 100; i++) {
                if ((await iframeEvaluate("document.querySelector('#print-result')?.textContent ?? ''")).includes(text)) return;
                await delay(70);
            }
            throw Error(`printMessages did not report ${text}`);
        };
        const changeSend = async (enabled, result = enabled ? 'enable' : 'disable') => {
            await iframeEvaluate(`document.querySelector('#send-${enabled ? 'enable' : 'disable'}').click()`);
            for (let i = 0; i < 100; i++) {
                if ((await iframeEvaluate("document.querySelector('#send-result')?.textContent ?? ''")).includes(result)) return;
                await delay(70);
            }
            throw Error(`Send controls did not report ${result}`);
        };
        const readGeneration = async () => {
            await iframeEvaluate("document.querySelector('#read-generation').click()");
            return JSON.parse(await iframeEvaluate("document.querySelector('#generation-result').textContent"));
        };
        const generateDisabled = "[...document.querySelectorAll('.generation-composer button')].find(el=>el.textContent==='Generate')?.disabled";
        const swipeDisabled = "[...document.querySelectorAll('.transcript-row label')].find(el=>el.textContent.startsWith('Reply alternative'))?.querySelector('select')?.disabled";
        const openBound = async () => {
            await evaluate("[...document.querySelectorAll('.conversation-page button')].find(el=>el.textContent==='Extensions').click()");
            await waitFor("document.querySelector('.conversation-page .preset-layout .preset-item span')?.textContent==='Native UI demo'");
            await evaluate("document.querySelector('.conversation-page .preset-layout .preset-item').click()");
            await click('Load extension UI'); await waitFor("document.body.innerText.includes('Extension modules loaded.')");
        };
        try {
            // A settings-only host has no authority to choose a chat for itself.
            await click('Reload extension UI'); await waitFor("document.body.innerText.includes('Extension modules loaded.')");
            expect(JSON.parse(await iframeEvaluate("document.querySelector('#selection-result').textContent"))).toEqual({ chatLength: 0, name1: personas.username, name2: 'SillyTavern System' });
            const reads = requests.filter(item => item.route === '/api/v1/chats/conversation').length;
            await iframeEvaluate("document.querySelector('#print-probe').click()"); await waitOutput('selected conversation');
            await changeSend(false, 'selected conversation');
            expect(requests.filter(item => item.route === '/api/v1/chats/conversation')).toHaveLength(reads);

            await evaluate("document.querySelector('.character-row').click()");
            await waitFor("document.querySelector('.chat-picker .preset-item')"); await click('conversation');
            await waitFor("document.querySelector('.message-text')");
            const beforePaging = chatQueries.length;
            await click('Older');
            for (let i = 0; i < 100 && chatQueries.length === beforePaging; i++) await delay(30);
            expect(new URLSearchParams(chatQueries.at(-1)).get('before')).toBe('41');
            await waitFor("document.querySelector('.message-text')");
            await input('.generation-composer textarea', 'Unsaved chat draft survives printing');
            await openBound();
            expect(JSON.parse(await iframeEvaluate("document.querySelector('#selection-result').textContent"))).toEqual({ characterId: 0, chatId: 'conversation', avatar: 'ada.png', selectedChat: 'conversation', chatLength: 41, metadataVariable: 'persisted', name1: personas.username, name2: 'Ada' });
            await iframeEvaluate("document.querySelector('#prompt-inject').click()");
            await click('Preview'); await waitFor("document.body.innerText.includes('Preview system prompt')");
            const injectedPreview = requests.filter(item=>item.route==='/api/v1/generations/preview').at(-1);
            expect(injectedPreview.body.extensionPrompts).toEqual({browser:{value:'Browser injection',position:1,depth:3,scan:true,role:2}});
            await iframeEvaluate("document.querySelector('#prompt-fail').click()");
            const previewsBefore=requests.filter(item=>item.route==='/api/v1/generations/preview').length;
            await click('Preview'); await waitFor("document.querySelector('[role=alert]')?.textContent.includes('Browser predicate failure')");
            expect(requests.filter(item=>item.route==='/api/v1/generations/preview')).toHaveLength(previewsBefore);
            expect(generationPosts).toBe(3);
            const storageBeforeCapture = await evaluate('JSON.stringify(localStorage)');
            await click('Generate'); await waitFor("document.querySelector('[role=alert]')?.textContent.includes('Browser predicate failure')");
            expect(generationPosts).toBe(3);
            expect(await evaluate('JSON.stringify(localStorage)')).toBe(storageBeforeCapture);
            await iframeEvaluate("document.querySelector('#prompt-remove').click()");
            await click('Preview'); await waitFor("document.body.innerText.includes('Preview system prompt') && !document.querySelector('[role=alert]')");
            expect(requests.filter(item=>item.route==='/api/v1/generations/preview').at(-1).body.extensionPrompts).toBeUndefined();
            const writesBefore = requests.filter(item => item.method !== 'GET').length;
            const editsBefore = editPosts, generationsBefore = generationPosts;
            await waitFor(`(${generateDisabled})===false && (${swipeDisabled})===false`);
            await changeSend(false); await waitFor(`(${generateDisabled})===true && (${swipeDisabled})===true`);
            expect(await evaluate("document.querySelector('.generation-composer textarea').value")).toBe('Unsaved chat draft survives printing');
            await changeSend(true); await waitFor(`(${generateDisabled})===false && (${swipeDisabled})===false`);
            expect(await readGeneration()).toEqual({ pressed: false, generating: false, context: false });
            const previousGeneration = generation;
            try {
                generation = { ...generation, characterId: 'ada', targetKind: 'character', chatId: 'conversation', status: 'streaming', drained: false, acknowledged: false };
                await click('Reload transcript & outcomes'); await waitFor(`(${generateDisabled})===true`);
                for (let i = 0; i < 100 && !(await readGeneration()).pressed; i++) await delay(30);
                expect(await readGeneration()).toEqual({ pressed: true, generating: true, context: true });
                // A newly loaded frame must see activity before extension init.
                await click('Reload extension UI'); await waitFor("document.body.innerText.includes('Extension modules loaded.')");
                expect(await readGeneration()).toEqual({ pressed: true, generating: true, context: true });
                generation = { ...generation, seq: generation.seq + 1, status: 'unknown', drained: true };

                await click('Reload transcript & outcomes'); await waitFor(`(${generateDisabled})===true`);
                for (let i = 0; i < 100 && (await readGeneration()).pressed; i++) await delay(30);
                expect(await readGeneration()).toEqual({ pressed: false, generating: false, context: false });
                await changeSend(false); await changeSend(true);
                expect(await readGeneration()).toEqual({ pressed: false, generating: false, context: false });
                expect(await evaluate(generateDisabled)).toBe(true);
            } finally { generation = previousGeneration; }
            await click('Reload transcript & outcomes'); await waitFor(`(${generateDisabled})===false`);
            await changeSend(false); await waitFor(`(${generateDisabled})===true`);
            await click('Reload extension UI'); await waitFor("document.body.innerText.includes('Extension modules loaded.')");
            await waitFor(`(${generateDisabled})===false && (${swipeDisabled})===false`);
            await changeSend(false); await waitFor(`(${generateDisabled})===true`);
            await evaluate("[...document.querySelectorAll('.conversation-page button')].find(el=>el.textContent==='Extensions').click()");
            await waitFor(`(${generateDisabled})===false && (${swipeDisabled})===false`);
            await openBound();
            message = { ...message, mes: 'Refreshed through printMessages <script>literal text</script>' };
            await evaluate("window.__printScrolled=false; const el=document.querySelector('.transcript-row'); el.scrollIntoView=()=>{window.__printScrolled=true};");
            await iframeEvaluate("document.querySelector('#print-probe').click()"); await waitOutput('done');
            expect(await evaluate("document.querySelector('.message-text').textContent")).toBe(message.mes);
            expect(await evaluate('window.__printScrolled')).toBe(true);
            expect(await evaluate("document.querySelector('.generation-composer textarea').value")).toBe('Unsaved chat draft survives printing');
            expect(await evaluate("document.querySelector('.message-text script')")).toBeNull();
            expect(new URLSearchParams(chatQueries.at(-1)).get('before')).toBe(String(Number.MAX_SAFE_INTEGER));
            expect(new URLSearchParams(chatQueries.at(-1)).get('limit')).toBe('100');
            expect(requests.filter(item => item.method !== 'GET')).toHaveLength(writesBefore);
            expect(editPosts).toBe(editsBefore); expect(generationPosts).toBe(generationsBefore);
            const beforeReload = chatQueries.length;
            await click('Reload transcript & outcomes');
            for (let i = 0; i < 100 && chatQueries.length === beforeReload; i++) await delay(30);
            await waitFor("document.querySelector('.message-text')");
            expect(new URLSearchParams(chatQueries.at(-1)).get('before')).toBe(String(Number.MAX_SAFE_INTEGER));

            const readsBeforeFailure = requests.filter(item => item.route === '/api/v1/chats/conversation').length;
            failPrintRead = true;
            await iframeEvaluate("document.querySelector('#print-probe').click()"); await waitOutput('Transcript read failed');
            expect(requests.filter(item => item.route === '/api/v1/chats/conversation')).toHaveLength(readsBeforeFailure + 1);
            expect(await evaluate("document.querySelector('.message-text').textContent")).toBe(message.mes);
            await click('Edit raw'); await input('.transcript-row textarea', 'Uncommitted raw edit');
            await iframeEvaluate("document.querySelector('#print-probe').click()"); await waitOutput('Finish editing');
            expect(await evaluate("document.querySelector('.transcript-row textarea').value")).toBe('Uncommitted raw edit');
            await click('Cancel edit');

            await click('Groups'); await waitFor("document.querySelector('.preset-list .preset-item')");
            await evaluate("document.querySelector('.preset-list .preset-item').click()"); await click('Open chats');
            await waitFor("document.querySelector('.chat-picker .preset-item')"); await click('shared'); await waitFor("document.querySelector('.message-text')");
            await waitFor("[...document.querySelectorAll('label')].find(el=>el.textContent.trim()==='Display projection')?.querySelector('input:not(:disabled)')");
            await evaluate("[...document.querySelectorAll('label')].find(el=>el.textContent.trim()==='Display projection').querySelector('input').click()");
            await waitFor("document.querySelector('.message-text')?.textContent.startsWith('Display:')");
            await openBound();
            expect(JSON.parse(await iframeEvaluate("document.querySelector('#selection-result').textContent"))).toEqual({ groupId: 'team', chatId: 'shared', chatLength: 1, name1: personas.username, name2: '' });
            groupMessage = { ...groupMessage, mes: 'Group refreshed through printMessages' };
            const groupWritesBefore = requests.filter(item => item.method !== 'GET' && !item.route.endsWith('/render')).length;
            await iframeEvaluate("document.querySelector('#print-probe').click()"); await waitOutput('done');
            expect(await evaluate("document.querySelector('.message-text').textContent")).toBe(`Display: ${groupMessage.mes}`);
            expect(requests.filter(item => item.method !== 'GET' && !item.route.endsWith('/render'))).toHaveLength(groupWritesBefore);
            expect(generationPosts).toBe(generationsBefore);
            expect(await evaluate("document.querySelector('iframe').getAttribute('sandbox')")).toBe('allow-scripts');
            expect(violations).toEqual([]); expect(errors).toEqual([]);
        } finally { usePrintProbe = false; }
    }, 30_000);

    test('checks the saved provider connection only on explicit action and disables checks for unsaved drafts', async () => {
        const before = requests.filter(item => item.route === '/api/v1/provider-status/check').length;
        const generationsBefore = generationPosts;
        await click('API settings'); await waitFor("document.querySelector('[data-provider-status]')");
        await waitFor("[...document.querySelectorAll('button')].find(el=>el.textContent.trim()==='Check provider connection' && !el.disabled)");
        expect(requests.filter(item => item.route === '/api/v1/provider-status/check')).toHaveLength(before);
        await click('Check provider connection'); await waitFor("document.querySelector('[data-provider-status]')?.dataset.providerStatus==='valid'");
        await input('#custom-model','unsaved model');
        expect(await evaluate("[...document.querySelectorAll('button')].find(el=>el.textContent.trim()==='Check provider connection').disabled")).toBe(true);
        await input('#custom-model','browser-model');
        failProviderCheck=true;
        try {
            await click('Check provider connection'); await waitFor("document.querySelector('[data-provider-status]')?.dataset.providerStatus==='failed'");
            expect(await evaluate("document.body.innerText.includes('Model catalog unavailable.')")).toBe(true);
            expect(requests.filter(item => item.route === '/api/v1/provider-status/check')).toHaveLength(before+2);
            expect(generationPosts).toBe(generationsBefore); expect(violations).toEqual([]); expect(errors).toEqual([]);
        } finally { failProviderCheck=false; providerStatus={onlineStatus:'no_connection',state:'unchecked',checkedAt:null}; }
    }, 20_000);

    test('manages both plugin kinds with explicit trust, bulk results and no mutation replay', async () => {
        capabilities.resources.packageManagement = true;
        await evaluate("document.querySelector('[aria-label=\"API connection\"]').click()"); await waitFor("document.querySelector('[role=dialog]')"); await click('Verify & connect');
        await waitFor("!document.querySelector('[role=dialog]')"); await click('Plugin management');
        await waitFor("document.querySelectorAll('.plugin-row').length === 3");
        expect(await evaluate("document.querySelectorAll('.plugin-row input:disabled').length")).toBe(1);
        await input('.plugin-install-fields select', 'server-plugin');
        await input('.plugin-install-fields input[placeholder="my-plugin"]', 'new-service');
        await input('.plugin-install-fields input[type=url]', 'https://example.test/new-service.git');
        await click('Review installation');
        expect(await evaluate("[...document.querySelectorAll('.plugin-confirmation button')].find(el=>el.textContent==='Install plugin').disabled")).toBe(true);
        expect(requests.filter(item => item.route === '/api/v1/package-management/install')).toHaveLength(0);
        await evaluate("document.querySelector('.plugin-confirmation input[type=checkbox]').click()"); await click('Install plugin');
        await waitFor("document.querySelectorAll('.plugin-row').length === 4 && !document.querySelector('.plugin-confirmation')");
        expect(requests.filter(item => item.route.endsWith('/package-management/install'))).toHaveLength(1);
        await evaluate("document.querySelector('.plugin-bulk input').click()"); await click('Upgrade selected');
        expect(await evaluate("document.querySelectorAll('.plugin-confirmation li').length")).toBe(3);
        await evaluate("document.querySelector('.plugin-confirmation input').click()"); await click('Upgrade plugins');
        await waitFor("document.querySelector('.plugin-results')?.textContent.includes('Working tree has local changes.')");
        expect(await evaluate("document.querySelector('.plugin-results').textContent")).toContain('Succeeded');
        expect(await evaluate("document.querySelector('.plugin-results').textContent")).toContain('Failed');
        // A conflict must block more writes until explicit observation/reload.
        failPluginAction = true;
        await evaluate("document.querySelector('.plugin-bulk input').click()"); await click('Remove selected');
        await evaluate("document.querySelector('.plugin-confirmation input').click()"); await click('Remove plugins');
        await waitFor("document.body.innerText.includes('Inventory changed. Reload before continuing.')");
        const posts = requests.filter(item => item.route.endsWith('/package-management/bulk')).length;
        expect(await evaluate("[...document.querySelectorAll('button')].find(el=>el.textContent==='Remove selected').disabled")).toBe(true);
        await click('Reload inventory'); await waitFor("!document.querySelector('.plugin-management [role=alert]')");
        expect(requests.filter(item => item.route.endsWith('/package-management/bulk'))).toHaveLength(posts);
        await input('.plugin-filters input', 'new-service'); await evaluate("document.querySelector('.plugin-bulk input').click()"); await click('Remove selected');
        expect(await evaluate("document.querySelectorAll('.plugin-confirmation li').length")).toBe(1);
        await evaluate("document.querySelector('.plugin-confirmation input').click()"); await click('Remove plugins');
        await waitFor("document.querySelector('.plugin-results')?.textContent.includes('Files changed.') && document.querySelectorAll('.plugin-row').length===0");
        expect(pluginInventory.packages.some(item => item.name === 'new-service')).toBe(false);
        expect(await evaluate("document.body.innerText")).toContain('Restart the backend');
        await input('.plugin-filters input', '');
        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await waitFor('document.documentElement.scrollWidth <= window.innerWidth');
        await waitFor("document.querySelector('.sidebar').getBoundingClientRect().right <= 0");
        if (process.env.CLIENT_SCREENSHOT_DIR) { const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(path.join(process.env.CLIENT_SCREENSHOT_DIR, 'client-plugins-mobile.png'), Buffer.from(image.data, 'base64')); }
        await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        expect(violations).toEqual([]); expect(errors).toEqual([]);
    }, 30_000);

    test('switches language without refetching or losing drafts and remembers the choice after reload', async () => {
        await click('Character cards'); await waitFor("document.querySelector('.preset-list .preset-item')");
        await evaluate("document.querySelector('.preset-list .preset-item').click()");
        await waitFor("document.querySelector('.resource-fields textarea')?.value === 'Edited character'");
        await input('.resource-fields textarea', '未保存的角色草稿 {name}');
        const requestCount = requests.length;
        await input('.top-actions .language-switcher select', 'zh-CN');
        await waitFor("document.documentElement.lang === 'zh-CN' && document.querySelector('.settings-heading h1')?.textContent === '角色'");
        expect(await evaluate("document.querySelector('.resource-fields textarea').value")).toBe('未保存的角色草稿 {name}');
        expect(await evaluate("document.querySelector('.resource-fields input').value")).toBe('Ada');
        expect(await evaluate("document.querySelector('.top-actions select').getAttribute('aria-label')")).toBe('语言');
        expect(requests).toHaveLength(requestCount);
        expect(generationPosts).toBe(3);
        await input('.top-actions .language-switcher select', 'en-US');
        await waitFor("document.documentElement.lang === 'en-US' && document.querySelector('.settings-heading h1')?.textContent === 'Characters'");
        expect(await evaluate("document.querySelector('.resource-fields textarea').value")).toBe('未保存的角色草稿 {name}');
        expect(requests).toHaveLength(requestCount);
        await input('.top-actions .language-switcher select', 'zh-CN');
        await waitFor("document.documentElement.lang === 'zh-CN'");
        expect(await evaluate("localStorage.getItem('st-v1-locale')")).toBe('zh-CN');
        expect(await evaluate("document.cookie.includes('st-v1-locale=zh-CN')")).toBe(true);
        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await waitFor('document.documentElement.scrollWidth <= window.innerWidth');
        await waitFor("document.querySelector('.sidebar').getBoundingClientRect().right <= 0");
        if (process.env.CLIENT_SCREENSHOT_DIR) { const image = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.env.CLIENT_SCREENSHOT_DIR, 'client-i18n-mobile.png'), Buffer.from(image.data, 'base64')); }
        // Explicit navigation handles the draft confirmation without saving it.
        await evaluate("document.querySelector('[aria-label=\"打开导航\"]').click()");
        await waitFor("document.querySelector('.sidebar.mobile-open')");
        await click('概览');
        await send('Page.reload');
        await waitFor("document.documentElement.lang === 'zh-CN' && document.querySelector('.top-actions select')?.value === 'zh-CN' && document.querySelector('.dot.online')");
        expect(card.raw.data.description).toBe('Edited character');
        expect(generationPosts).toBe(3);
        await input('.top-actions .language-switcher select', 'en-US');
        await waitFor("document.documentElement.lang === 'en-US'");
        expect(violations).toEqual([]); expect(errors).toEqual([]);
    }, 30_000);

    test('server rendering negotiates language and honors a saved preference', async () => {
        const chinese = await fetch(`http://127.0.0.1:${port}`, { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8' } });
        const html = await chinese.text();
        expect(html).toContain('<html lang="zh-CN"');
        expect(html).toContain('你的对话工作区。');
        const savedEnglish = await fetch(`http://127.0.0.1:${port}`, { headers: { 'Accept-Language': 'zh-CN', Cookie: 'st-v1-locale=en-US' } });
        expect(await savedEnglish.text()).toContain('<html lang="en-US"');
    }, 15_000);
});
