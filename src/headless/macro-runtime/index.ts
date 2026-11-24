import { MacroEngine } from './compat/engine/MacroEngine.js';
import { MacroRegistry } from './compat/engine/MacroRegistry.js';
import { MacroEnvBuilder } from './compat/engine/MacroEnvBuilder.js';
import * as script from './compat/script.js';
import * as groupCards from './compat/group-cards.js';
import * as variables from './compat/variables.js';
import * as utils from './compat/utils.js';
import * as instruct from './compat/instruct.js';
import { initMacros } from './compat/legacy.js';
import { activate, activeFrame, installRuntime, moment } from './platform.js';
import { ApiError } from '../contract.js';

installRuntime({ script, groupCards, variables, utils, instruct, engine: MacroEngine, envBuilder: MacroEnvBuilder });
initMacros();
const execute = MacroRegistry.executeMacro.bind(MacroRegistry);
MacroRegistry.executeMacro = (call, options) => {
    const frame = activeFrame();
    if (frame && ++frame.operations > 10000) { frame.limitExceeded = true; throw new Error('Macro operation limit exceeded.'); }
    if (frame && ['space', 'newline'].includes(String(call.name).toLowerCase())) {
        const count = Number(call.args?.[0] ?? 1);
        if (count > 1_048_576) {
            frame.limitExceeded = true;
            throw new Error('Macro allocation limit exceeded.');
        }
    }
    const result = execute(call, options);
    if (typeof result === 'string' && result.length > 1_048_576) { if (frame) frame.limitExceeded = true; throw new Error('Macro output limit exceeded.'); }
    return result;
};

export function inMacroFrame(frame: any, callback: any) {
    if (activeFrame() === frame) return callback();
    const previous = activate(frame);
    const locale = moment.locale();
    const previousNow = moment.now;
    const previousTimezone = process.env.TZ;
    try {
        utils.resetNativeDateCache();
        if (frame.locale) {
            const localeInfo = new Intl.Locale(frame.locale);
            moment.locale([localeInfo.baseName, [localeInfo.language, localeInfo.region].filter(Boolean).join('-'), localeInfo.language]);
        }
        if (frame.timeZone) {
            try {
                new Intl.DateTimeFormat('en', { timeZone: frame.timeZone });
                process.env.TZ = frame.timeZone;
            } catch { throw new ApiError(400, 'validation', 'Invalid native macro time zone.'); }
        }
        if (frame.now != null) moment.now = () => frame.now;
        return callback();
    } finally {
        activate(previous);
        moment.locale(locale); moment.now = previousNow;
        if (previousTimezone == null) delete process.env.TZ; else process.env.TZ = previousTimezone;
    }
}
export function evaluateNativeMacros(frame: any, text: any, options: Record<string, any> = {}) {
    return inMacroFrame(frame, () => {
        if (typeof text !== 'string') return '';
        if (text.length > 1_048_576) throw new ApiError(422, 'validation', 'Macro input exceeds its size limit.');
        const postProcess = options.postProcessFn ?? ((value: any) => value);
        const result = script.substituteParams(text, { ...options, postProcessFn: (value: any) => {
            const processed = postProcess(value);
            frame.generatedCharacters = (frame.generatedCharacters ?? 0) + String(processed ?? '').length;
            if (frame.generatedCharacters > 8_388_608) { frame.limitExceeded = true; throw new Error('Macro expansion exceeds its output budget.'); }
            return processed;
        } });
        if (frame.limitExceeded || result.length > 1_048_576) throw new ApiError(422, 'validation', 'Macro evaluation exceeded its operation/output limit.');
        return result;
    });
}
export { script as upstreamMacroScript, MacroEngine, MacroEnvBuilder, MacroRegistry };
