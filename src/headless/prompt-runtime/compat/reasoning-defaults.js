// Maintained manually from the upstream compatibility sources.
export const DEFAULT_REASONING_TEMPLATE = 'Think XML';
export const defaultReasoningSettings = {
        name: DEFAULT_REASONING_TEMPLATE,
        auto_parse: false,
        add_to_prompts: false,
        auto_expand: false,
        show_hidden: false,
        prefix: '<think>',
        suffix: '</think>',
        separator: '\n',
        max_additions: 1,
    };
