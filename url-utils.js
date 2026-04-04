/**
 * URL normalization and preview utilities for SillyTavern-ApiHub.
 * Ported from moonlit-whispers/src/components/api/ApiConfigPanel.tsx
 */

/** Default API version per protocol format */
export const PROVIDER_VERSION = {
    openai: 'v1',
    anthropic: 'v1',
    gemini: 'v1beta',
};

/** Known version segments to detect and replace */
const KNOWN_VERSIONS = new Set(['v1', 'v1beta', 'v2', 'v3']);

/** Protocol format options with defaults */
export const FORMAT_OPTIONS = [
    {
        value: 'openai',
        label: 'OpenAI Compatible',
        defaultEndpoint: 'https://api.openai.com',
        defaultModel: 'gpt-4o',
        defaultModels: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'gpt-4.1'],
    },
    {
        value: 'anthropic',
        label: 'Anthropic',
        defaultEndpoint: 'https://api.anthropic.com',
        defaultModel: 'claude-sonnet-4-20250514',
        defaultModels: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-4-20250506'],
    },
    {
        value: 'gemini',
        label: 'Google Gemini',
        defaultEndpoint: 'https://generativelanguage.googleapis.com',
        defaultModel: 'gemini-2.5-flash',
        defaultModels: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    },
];

/**
 * Normalize a base URL by handling trailing slashes, version segments, and # literal mode.
 * @param {string} baseUrl Raw user input URL
 * @param {string} format Protocol format ('openai' | 'anthropic' | 'gemini')
 * @returns {{ normalized: string, literal: boolean }} Normalized URL and whether literal mode is active
 */
export function normalizeUrl(baseUrl, format) {
    let raw = (baseUrl || '').trim();
    let literal = false;

    if (raw.endsWith('#')) {
        // # = literal mode: user controls the URL exactly, no auto-appending
        raw = raw.slice(0, -1).replace(/\/+$/, '');
        literal = true;
    } else {
        raw = raw.replace(/\/+$/, '');
        const version = PROVIDER_VERSION[format];
        if (version && !raw.endsWith(`/${version}`)) {
            // If URL ends with a known version segment, strip it first
            const parts = raw.split('/');
            const last = parts[parts.length - 1]?.toLowerCase();
            if (last && KNOWN_VERSIONS.has(last)) {
                raw = parts.slice(0, -1).join('/');
            }
            raw = `${raw}/${version}`;
        }
    }

    return { normalized: raw, literal };
}

/**
 * Compute URL preview showing final request endpoints for a given configuration.
 * @param {string} format Protocol format ('openai' | 'anthropic' | 'gemini')
 * @param {string} baseUrl User-provided base URL
 * @param {string} model Selected model name
 * @returns {{ normalizedBaseUrl: string, literal: boolean, authScheme: string, chatUrl: string, chatMethod: string, modelsUrl: string, modelsMethod: string }}
 */
export function computeUrlPreview(format, baseUrl, model) {
    if (!baseUrl || !baseUrl.trim()) {
        return null;
    }

    const { normalized: raw, literal } = normalizeUrl(baseUrl, format);

    let chatUrl, modelsUrl, authScheme;

    if (format === 'anthropic') {
        chatUrl = `${raw}/messages`;
        modelsUrl = `${raw}/models`;
        authScheme = 'x-api-key: <api_key>';
    } else if (format === 'gemini') {
        const m = model || '<model>';
        chatUrl = `${raw}/models/${m}:streamGenerateContent?key=***`;
        modelsUrl = `${raw}/models?key=***`;
        authScheme = 'URL query key=';
    } else {
        // openai and any compatible
        chatUrl = `${raw}/chat/completions`;
        modelsUrl = `${raw}/models`;
        authScheme = 'Authorization: Bearer';
    }

    return {
        normalizedBaseUrl: raw,
        literal,
        authScheme,
        chatUrl,
        chatMethod: 'POST',
        modelsUrl,
        modelsMethod: 'GET',
    };
}

/**
 * Mask an API key for display: show first 8 and last 4 chars.
 * @param {string} key The API key
 * @returns {string} Masked key
 */
export function maskApiKey(key) {
    if (!key) return '';
    if (key.length <= 12) return '****';
    return `${key.slice(0, 8)}****${key.slice(-4)}`;
}

/**
 * Get the FORMAT_OPTIONS entry for a given format value.
 * @param {string} format
 * @returns {object|undefined}
 */
export function getFormatOption(format) {
    return FORMAT_OPTIONS.find(f => f.value === format);
}
