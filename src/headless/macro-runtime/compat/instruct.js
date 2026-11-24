// Maintained manually from the upstream compatibility sources.
import { power_user, selected_group, name1, name2, getGroupNames } from '../platform.js';
import { substituteParams } from './script.js';
const names_behavior_types = { NONE:'none', FORCE:'force', ALWAYS:'always' };
export function formatInstructModeExamples(mesExamplesArray, name1, name2) {
    const blockHeading = power_user.context.example_separator ? `${substituteParams(power_user.context.example_separator)}\n` : '';

    if (power_user.instruct.skip_examples) {
        return mesExamplesArray.map(x => x.replace(/<START>\n/i, blockHeading));
    }

    const includeNames = power_user.instruct.names_behavior === names_behavior_types.ALWAYS;
    const includeGroupNames = selected_group && [names_behavior_types.ALWAYS, names_behavior_types.FORCE].includes(power_user.instruct.names_behavior);

    let inputPrefix = power_user.instruct.input_sequence || '';
    let outputPrefix = power_user.instruct.output_sequence || '';
    let inputSuffix = power_user.instruct.input_suffix || '';
    let outputSuffix = power_user.instruct.output_suffix || '';

    if (power_user.instruct.macro) {
        inputPrefix = substituteParams(inputPrefix, { name1Override: name1, name2Override: name2 });
        outputPrefix = substituteParams(outputPrefix, { name1Override: name1, name2Override: name2 });
        inputSuffix = substituteParams(inputSuffix, { name1Override: name1, name2Override: name2 });
        outputSuffix = substituteParams(outputSuffix, { name1Override: name1, name2Override: name2 });

        inputPrefix = inputPrefix.replace(/{{name}}/gi, name1);
        outputPrefix = outputPrefix.replace(/{{name}}/gi, name2);
        inputSuffix = inputSuffix.replace(/{{name}}/gi, name1);
        outputSuffix = outputSuffix.replace(/{{name}}/gi, name2);

        if (!inputSuffix && power_user.instruct.wrap) {
            inputSuffix = '\n';
        }

        if (!outputSuffix && power_user.instruct.wrap) {
            outputSuffix = '\n';
        }
    }

    const separator = power_user.instruct.wrap ? '\n' : '';
    const formattedExamples = [];

    for (const item of mesExamplesArray) {
        const cleanedItem = item.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, '');
        const blockExamples = parseExampleIntoIndividual(cleanedItem, includeGroupNames);

        if (blockExamples.length === 0) {
            continue;
        }

        if (blockHeading) {
            formattedExamples.push(blockHeading);
        }

        for (const example of blockExamples) {
            // If group names were included, we don't want to add any additional prefix as it already was applied.
            // Otherwise, if force group/persona names is set, we should override the include names for the user placeholder
            const includeThisName = !includeGroupNames && (includeNames || (power_user.instruct.names_behavior === names_behavior_types.FORCE && example.name == 'example_user'));

            const prefix = example.name == 'example_user' ? inputPrefix : outputPrefix;
            const suffix = example.name == 'example_user' ? inputSuffix : outputSuffix;
            const name = example.name == 'example_user' ? name1 : name2;
            const messageContent = includeThisName ? `${name}: ${example.content}` : example.content;
            const formattedMessage = [prefix, messageContent + suffix].filter(x => x).join(separator);
            formattedExamples.push(formattedMessage);
        }
    }

    if (formattedExamples.length === 0) {
        return mesExamplesArray.map(x => x.replace(/<START>\n/i, blockHeading));
    }
    return formattedExamples;
}

export function getInstructMacros(env) {
    /** @type {{ key: string,value: string, enabled: boolean }[]} */
    const instructMacros = [
        // Instruct template macros
        {
            key: 'instructStoryStringPrefix',
            value: power_user.instruct.story_string_prefix,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructStoryStringSuffix',
            value: power_user.instruct.story_string_suffix,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructInput|instructUserPrefix',
            value: power_user.instruct.input_sequence,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructUserSuffix',
            value: power_user.instruct.input_suffix,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructOutput|instructAssistantPrefix',
            value: power_user.instruct.output_sequence,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructSeparator|instructAssistantSuffix',
            value: power_user.instruct.output_suffix,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructSystemPrefix',
            value: power_user.instruct.system_sequence,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructSystemSuffix',
            value: power_user.instruct.system_suffix,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructFirstOutput|instructFirstAssistantPrefix',
            value: power_user.instruct.first_output_sequence || power_user.instruct.output_sequence,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructLastOutput|instructLastAssistantPrefix',
            value: power_user.instruct.last_output_sequence || power_user.instruct.output_sequence,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructStop',
            value: power_user.instruct.stop_sequence,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructUserFiller',
            value: power_user.instruct.user_alignment_message,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructSystemInstructionPrefix',
            value: power_user.instruct.last_system_sequence,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructFirstInput|instructFirstUserPrefix',
            value: power_user.instruct.first_input_sequence || power_user.instruct.input_sequence,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructLastInput|instructLastUserPrefix',
            value: power_user.instruct.last_input_sequence || power_user.instruct.input_sequence,
            enabled: power_user.instruct.enabled,
        },
        // System prompt macros
        {
            key: 'systemPrompt',
            value: power_user.prefer_character_prompt && env.charPrompt ? env.charPrompt : power_user.sysprompt.content,
            enabled: power_user.sysprompt.enabled,
        },
        {
            key: 'defaultSystemPrompt|instructSystem|instructSystemPrompt',
            value: power_user.sysprompt.content,
            enabled: power_user.sysprompt.enabled,
        },
        // Context template macros
        {
            key: 'chatSeparator',
            value: power_user.context.example_separator,
            enabled: true,
        },
        {
            key: 'chatStart',
            value: power_user.context.chat_start,
            enabled: true,
        },
    ];

    const macros = [];

    for (const { key, value, enabled } of instructMacros) {
        const regex = new RegExp(`{{(${key})}}`, 'gi');
        const replace = () => enabled ? value : '';
        macros.push({ regex, replace });
    }

    return macros;
}

export function parseExampleIntoIndividual(messageExampleString, appendNamesForGroup = true) {
    const groupBotNames = getGroupNames().map(name => `${name}:`);

    let result = []; // array of msgs
    let tmp = messageExampleString.split('\n');
    let cur_msg_lines = [];
    let in_user = false;
    let in_bot = false;
    let botName = name2;

    // DRY my cock and balls :)
    function add_msg(name, role, system_name) {
        // join different newlines (we split them by \n and join by \n)
        // remove char name
        // strip to remove extra spaces
        let parsed_msg = cur_msg_lines.join('\n').replace(name + ':', '').trim();

        if (appendNamesForGroup && selected_group && ['example_user', 'example_assistant'].includes(system_name)) {
            parsed_msg = `${name}: ${parsed_msg}`;
        }

        result.push({ 'role': role, 'content': parsed_msg, 'name': system_name });
        cur_msg_lines = [];
    }
    // skip first line as it'll always be "This is how {bot name} should talk"
    for (let i = 1; i < tmp.length; i++) {
        let cur_str = tmp[i];
        // if it's the user message, switch into user mode and out of bot mode
        // yes, repeated code, but I don't care
        if (cur_str.startsWith(name1 + ':')) {
            in_user = true;
            // we were in the bot mode previously, add the message
            if (in_bot) {
                add_msg(botName, 'system', 'example_assistant');
            }
            in_bot = false;
        } else if (cur_str.startsWith(name2 + ':') || groupBotNames.some(n => cur_str.startsWith(n))) {
            if (!cur_str.startsWith(name2 + ':') && groupBotNames.length) {
                botName = cur_str.split(':')[0];
            }

            in_bot = true;
            // we were in the user mode previously, add the message
            if (in_user) {
                add_msg(name1, 'system', 'example_user');
            }
            in_user = false;
        }
        // push the current line into the current message array only after checking for presence of user/bot
        cur_msg_lines.push(cur_str);
    }
    // Special case for last message in a block because we don't have a new message to trigger the switch
    if (in_user) {
        add_msg(name1, 'system', 'example_user');
    } else if (in_bot) {
        add_msg(botName, 'system', 'example_assistant');
    }
    return result;
}