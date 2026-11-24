// Maintained manually from the upstream compatibility sources.
import { power_user, substituteParams, selected_group, name2, getRegexedString } from '../platform.js';
import { regex_placement } from '../../regex-runtime.js';
export { defaultReasoningSettings } from './reasoning-defaults.js';
export class PromptReasoning {
    /**
     * An instance initiated during the latest prompt processing.
     * @type {PromptReasoning}
     * */
    static #LATEST = null;
    /**
     * @readonly Zero-width space character used as a placeholder for reasoning.
     * @type {string}
    */
    static REASONING_PLACEHOLDER = '\u200B';

    /**
     * Returns the latest formatted reasoning prefix if the prefix is incomplete.
     * @returns {string} Formatted reasoning prefix
     */
    static getLatestPrefix() {
        if (!PromptReasoning.#LATEST) {
            return '';
        }

        if (!PromptReasoning.#LATEST.prefixIncomplete) {
            return '';
        }

        return PromptReasoning.#LATEST.prefixReasoningFormatted;
    }

    /**
     * Free the latest reasoning instance.
     * To be called when the generation has ended or stopped.
     */
    static clearLatest() {
        PromptReasoning.#LATEST = null;
    }

    constructor() {
        PromptReasoning.#LATEST = this;

        /** @type {number} */
        this.counter = 0;
        /** @type {number} */
        this.prefixLength = -1;
        /** @type {string} */
        this.prefixReasoning = '';
        /** @type {string} */
        this.prefixReasoningFormatted = '';
        /** @type {number?} */
        this.prefixDuration = null;
        /** @type {boolean} */
        this.prefixIncomplete = false;
    }

    /**
     * Checks if the limit of reasoning additions has been reached.
     * @returns {boolean} True if the limit of reasoning additions has been reached, false otherwise.
     */
    isLimitReached() {
        if (!power_user.reasoning.add_to_prompts) {
            return true;
        }

        return this.counter >= power_user.reasoning.max_additions;
    }

    /**
     * Add reasoning to a message according to the power user settings.
     * @param {string} content Message content
     * @param {string} reasoning Message reasoning
     * @param {boolean} isPrefix Whether this is the last message prefix
     * @param {number?} duration Duration of the reasoning
     * @returns {string} Message content with reasoning
     */
    addToMessage(content, reasoning, isPrefix, duration) {
        // Disabled or reached limit of additions
        if (!isPrefix && (!power_user.reasoning.add_to_prompts || this.counter >= power_user.reasoning.max_additions)) {
            return content;
        }

        // No reasoning provided or a legacy placeholder
        if (!reasoning || reasoning === PromptReasoning.REASONING_PLACEHOLDER) {
            return content;
        }

        // Increment the counter
        this.counter++;

        // Substitute macros in variable parts
        const prefix = substituteParams(power_user.reasoning.prefix || '');
        const separator = substituteParams(power_user.reasoning.separator || '');
        const suffix = substituteParams(power_user.reasoning.suffix || '');

        // Combine parts with reasoning only
        if (isPrefix && !content) {
            const formattedReasoning = `${prefix}${reasoning}`;
            if (isPrefix) {
                this.prefixReasoning = reasoning;
                this.prefixReasoningFormatted = formattedReasoning;
                this.prefixLength = formattedReasoning.length;
                this.prefixDuration = duration;
                this.prefixIncomplete = true;
            }
            return formattedReasoning;
        }

        // Combine parts with reasoning and content
        const formattedReasoning = `${prefix}${reasoning}${suffix}${separator}`;
        if (isPrefix) {
            this.prefixReasoning = reasoning;
            this.prefixReasoningFormatted = formattedReasoning;
            this.prefixLength = formattedReasoning.length;
            this.prefixDuration = duration;
            this.prefixIncomplete = false;
        }
        return `${formattedReasoning}${content}`;
    }

    /**
     * Removes the reasoning prefix from the content.
     * @param {string} content Content with the reasoning prefix
     * @returns {string} Content without the reasoning prefix
     */
    removePrefix(content) {
        if (this.prefixLength > 0) {
            return content.slice(this.prefixLength);
        }
        return content;
    }
}
export function applyPromptReasoning(coreChat,type) {
const isContinue=type==='continue';
    const promptReasoning = new PromptReasoning();
    for (let i = coreChat.length - 1; i >= 0; i--) {
        const depth = coreChat.length - i - (isContinue ? 2 : 1);
        const isPrefix = isContinue && i === coreChat.length - 1;

        // In group chats, only include reasoning from the currently generating character
        const isOtherGroupMember = selected_group && coreChat[i].name !== name2;

        coreChat[i] = {
            ...coreChat[i],
            mes: isOtherGroupMember
                ? coreChat[i].mes
                : promptReasoning.addToMessage(
                    coreChat[i].mes,
                    getRegexedString(
                        String(coreChat[i].extra?.reasoning ?? ''),
                        regex_placement.REASONING,
                        { isPrompt: true, depth: depth },
                    ),
                    isPrefix,
                    coreChat[i].extra?.reasoning_duration,
                ),
        };
        if (promptReasoning.isLimitReached()) {
            break;
        }
    }


return coreChat;
}
