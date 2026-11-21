/** Remove the trailing upstream generation batch from an in-memory chat. */
export function removeGroupGenerationBatch(chat) {
    const generationId = chat.at(-1)?.extra?.gen_id;
    while (chat.length) {
        const last = chat.at(-1);
        const currentId = last.extra?.gen_id;
        if (Object.hasOwn(last, 'chat_metadata') || (generationId && currentId && generationId !== currentId) || last.is_user || last.is_system) break;
        chat.pop();
    }
}

/** Select the next group speakers using SillyTavern's activation strategies. */
export function selectGroupMembers({ group, characters, chat, input = '', auto = false, type = 'normal', forcedCharacterIndex, random = Math.random }) {
    const enabled = group.members.filter(member => !group.disabled_members.includes(member));
    const last = chat.at(-1);
    const userInput = Boolean(input.length && !auto);
    const activationText = userInput ? input : last && !last.is_system ? last.mes : '';
    const character = avatar => characters.find(item => item.avatar === avatar);
    const shuffle = members => {
        const result = [...members];
        for (let count = result.length; count > 0; count--) {
            const index = Math.floor(random() * count);
            [result[count - 1], result[index]] = [result[index], result[count - 1]];
        }
        return result;
    };
    const words = value => Array.from(String(value ?? '').matchAll(/\b\w+\b/gim), match => match[0].toLowerCase());
    const swipeMembers = allowSystem => {
        if (!last) return [];
        const selected = [];
        if (last.is_user || (!allowSystem && last.is_system) || last.extra?.type === 'narrator') {
            for (const message of [...chat].reverse()) {
                if (message.is_user || (!allowSystem && message.is_system) || message.extra?.type === 'narrator') continue;
                if (message.original_avatar) {
                    selected.push(message.original_avatar);
                    break;
                }
            }
            if (!selected.length) selected.push(shuffle(group.members)[0]);
        }
        if (last.original_avatar) {
            selected.push(last.original_avatar);
        } else {
            const match = characters.find(item => item.name === last.name && group.members.includes(item.avatar));
            if (match) selected.push(match.avatar);
        }
        return selected.filter(member => character(member));
    };
    if (typeof forcedCharacterIndex === 'number') {
        const forced = characters[forcedCharacterIndex];
        return forced ? [forced.avatar] : [];
    }
    if (type === 'quiet') {
        const selected = swipeMembers(true).slice(0, 1);
        return selected.length ? selected : group.members.slice(0, 1).filter(member => character(member));
    }
    if (type === 'swipe' || type === 'continue' || type === 'regenerate') return swipeMembers(false);
    if (type === 'impersonate') {
        const member = group.members[Math.floor(random() * group.members.length)];
        return character(member) ? [member] : [];
    }
    const strategy = Number(group.activation_strategy ?? 0);
    let selected = [];
    if (strategy === 1) {
        selected = enabled;
    } else if (strategy === 2) {
        if (!userInput) selected = shuffle(enabled).slice(0, 1);
    } else if (strategy === 3) {
        const spoken = [];
        for (const message of [...chat].reverse()) {
            if (message.is_user || userInput) break;
            if (message.is_system || message.extra?.type === 'narrator') continue;
            if (message.original_avatar) spoken.push(message.original_avatar);
        }
        let pool = enabled.filter(member => !spoken.includes(member));
        if (!pool.length) {
            pool = enabled.length > 1 && last && !last.is_user && last.original_avatar
                ? enabled.filter(member => member !== last.original_avatar) : enabled;
        }
        selected = [pool[Math.floor(random() * pool.length)]];
    } else if (strategy === 0) {
        const banned = !group.allow_self_responses && !userInput && last && !last.is_user ? last.name : undefined;
        for (const word of words(activationText)) {
            for (const member of enabled) {
                const item = character(member);
                if (item && item.name !== banned && words(item.name).includes(word)) {
                    selected.push(member);
                    break;
                }
            }
        }
        const chatty = [];
        for (const member of shuffle(enabled)) {
            const item = character(member);
            if (!item || item.name === banned) continue;
            const talkativeness = isNaN(item.talkativeness) ? 0.5 : Number(item.talkativeness);
            if (talkativeness >= random()) selected.push(member);
            if (talkativeness > 0) chatty.push(member);
        }
        const pool = chatty.length ? chatty : enabled;
        for (let attempts = 0; !selected.length && attempts < pool.length; attempts++) {
            const member = pool[Math.floor(random() * pool.length)];
            if (character(member)) selected.push(member);
        }
    }
    return [...new Set(selected)].filter(member => character(member));
}
