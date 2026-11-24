/** Redact credential values before exposing provider errors or configuration. */
export function redactProviderText(value: any, secrets: any[] = []) {
    let text = String(value ?? '');
    for (const secret of [...new Set(secrets.filter(item => typeof item === 'string' && item.length > 0))].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
    return text.replace(/\bBearer\s+[\w.~+/-]+=*/gi, 'Bearer [redacted]')
        .replace(/\bsk-[\w-]{8,}/g, '[redacted]')
        .replace(/(["']?(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*)["']?[^\s,"'<>}]+["']?/gi, '$1[redacted]');
}

const PRIVATE_FIELD = /^(?:api[_-]?key|.*[_-]api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|.*password|secret|.*[_-]secret|custom_include_headers)$/i;

export const isCredentialField = (key: any) => PRIVATE_FIELD.test(key);

function credentialUrl(value: any) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null;
    try { const url = new URL(value); return url.username || url.password ? url : null; } catch { return null; }
}

export function hasCredentialValues(value: any): any {
    if (credentialUrl(value)) return true;
    if (Array.isArray(value)) return value.some(hasCredentialValues);
    return Boolean(value && typeof value === 'object' && Object.entries(value).some(([key, item]): any  => (isCredentialField(key) && item !== null && item !== '') || hasCredentialValues(item)));
}

/** Copy public settings; never mutate stored credentials or echo them back. */
export function publicConfiguration(value: any): any {
    const url = credentialUrl(value);
    if (url) { url.username = ''; url.password = ''; return url.toString(); }
    if (Array.isArray(value)) return value.map(publicConfiguration);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]): any  => [key, PRIVATE_FIELD.test(key) && item !== null && item !== '' ? '[redacted]' : publicConfiguration(item)]));
    }
    return value;
}
