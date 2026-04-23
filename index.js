/**
 * SillyTavern-ApiHub — Unified API Connection Extension
 *
 * Replaces the native 24-source Chat Completion Source selector with a
 * protocol-centric UI (OpenAI Compatible / Anthropic / Gemini).
 */

import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { oai_settings, chat_completion_sources, proxies } from '../../../openai.js';
import { saveSettingsDebounced, getRequestHeaders, eventSource, event_types } from '../../../../script.js';
import { SECRET_KEYS, writeSecret, findSecret, rotateSecret, renameSecret, secret_state, deleteSecret } from '../../../secrets.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommandScope } from '../../../slash-commands/SlashCommandScope.js';
import { SlashCommandAbortController } from '../../../slash-commands/SlashCommandAbortController.js';
import { SlashCommandDebugController } from '../../../slash-commands/SlashCommandDebugController.js';
import { copyText } from '../../../utils.js';
import { computeUrlPreview, normalizeUrl, FORMAT_OPTIONS, getFormatOption, DEFAULT_MODELS } from './url-utils.js';

// ── Constants ──────────────────────────────────────────────────────

const MODULE_NAME = 'third-party/SillyTavern-ApiHub';

const DEFAULT_SETTINGS = {
    connections: [],
    activeConnectionId: null,
};

/** Maps our format names to ST's chat_completion_source values */
const FORMAT_TO_SOURCE = {
    openai: chat_completion_sources.CUSTOM,
    anthropic: chat_completion_sources.CLAUDE,
    gemini: chat_completion_sources.MAKERSUITE,
};

/** Maps our format names to the SECRET_KEYS used for API key storage */
const FORMAT_TO_SECRET = {
    openai: SECRET_KEYS.CUSTOM,
    anthropic: SECRET_KEYS.CLAUDE,
    gemini: SECRET_KEYS.MAKERSUITE,
};

const EMPTY_SECRET_LABEL = 'ApiHub Empty';

// Cache the last value we know was synced to each native secret slot.
// This avoids creating duplicate secret entries on every activation.
const syncedSecretValues = new Map();
const secretValueCache = new Map();
const SECRET_BINDING_WINDOW_MS = 120000;
let pendingSecretBinding = null;
let pendingSecretBindingToken = 0;
const bulkSecretSelections = new Map();
let secretManagerObserver = null;

// ── Settings helpers ───────────────────────────────────────────────

function getSettings() {
    return extension_settings.apiHub;
}

function getConnections() {
    return getSettings().connections;
}

function getConnection(id) {
    return getConnections().find(c => c.id === id);
}

function getActiveConnectionId() {
    return getSettings().activeConnectionId;
}

function getActiveConnection() {
    return getConnection(getActiveConnectionId());
}

function getSelectedConnectionId() {
    return $('#apihub_connection_select').val();
}

function getSelectedConnection() {
    return getConnection(getSelectedConnectionId());
}

function getSecretKeyForFormat(format) {
    return FORMAT_TO_SECRET[format];
}

function getActiveSecretEntry(secretKey) {
    const secrets = secret_state[secretKey];
    if (!Array.isArray(secrets)) return null;
    return secrets.find(secret => secret.active) || null;
}

function getActiveSecretLabel(secretKey) {
    return getActiveSecretEntry(secretKey)?.label || '';
}

function getSecretEntry(secretKey, secretId) {
    if (!secretId) return null;
    const secrets = secret_state[secretKey];
    if (!Array.isArray(secrets)) return null;
    return secrets.find(secret => secret.id === secretId) || null;
}

function getConnectionBoundSecretLabel(conn) {
    const secretKey = getSecretKeyForFormat(conn.format);
    return getSecretEntry(secretKey, conn.secretId)?.label || '';
}

function requiresReadableSecretValue(format) {
    return format === 'anthropic' || format === 'gemini';
}

function getSecretValueCacheKey(secretKey, secretId) {
    return `${secretKey}:${secretId}`;
}

function clearSecretCachesForKey(secretKey) {
    syncedSecretValues.delete(secretKey);
    for (const cacheKey of secretValueCache.keys()) {
        if (cacheKey.startsWith(`${secretKey}:`)) {
            secretValueCache.delete(cacheKey);
        }
    }
}

function countOpenDialogs() {
    return document.querySelectorAll('dialog[open]:not([closing])').length;
}

function startPendingSecretBinding(connectionId, secretKey) {
    const token = ++pendingSecretBindingToken;
    const baselineOpenDialogs = countOpenDialogs();
    pendingSecretBinding = {
        token,
        connectionId,
        secretKey,
        baselineOpenDialogs,
        sawDialog: false,
        expiresAt: Date.now() + SECRET_BINDING_WINDOW_MS,
    };

    const poll = () => {
        if (!pendingSecretBinding || pendingSecretBinding.token !== token) {
            return;
        }

        const openDialogs = countOpenDialogs();
        if (openDialogs > baselineOpenDialogs) {
            pendingSecretBinding.sawDialog = true;
        }

        if (pendingSecretBinding.sawDialog && openDialogs <= baselineOpenDialogs) {
            pendingSecretBinding = null;
            return;
        }

        if (Date.now() >= pendingSecretBinding.expiresAt) {
            pendingSecretBinding = null;
            return;
        }

        window.setTimeout(poll, 250);
    };

    window.setTimeout(poll, 0);
}

function getSecretReadFailureMessage(status) {
    if (status === 403) {
        return '无法读取绑定的密钥值（/api/secrets/find 返回 403）。如果你已经开启 allowKeysExposure，请确认修改的是当前实例实际使用的 config.yaml，并且已完整重启该实例。';
    }

    if (status === 404) {
        return '无法读取绑定的密钥值：对应的原生密钥条目不存在，或该密钥槽当前没有可读条目。';
    }

    if (status) {
        return `无法读取绑定的密钥值（/api/secrets/find 返回 ${status}）。请检查浏览器控制台和 SillyTavern 服务端日志。`;
    }

    return '无法读取绑定的密钥值（/api/secrets/find 请求失败）。请检查浏览器控制台和 SillyTavern 服务端日志。';
}

function getBulkSelectionForKey(secretKey) {
    if (!bulkSecretSelections.has(secretKey)) {
        bulkSecretSelections.set(secretKey, new Set());
    }

    return bulkSecretSelections.get(secretKey);
}

// ── Connection CRUD ────────────────────────────────────────────────

async function createConnection(name, format) {
    const fmt = getFormatOption(format) || FORMAT_OPTIONS[0];
    // Capture current preset/regex state as defaults for new connection
    const currentPresets = await readCurrentPresets();
    const conn = {
        id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: name || 'New Connection',
        format: fmt.value,
        endpoint: '',
        apiKey: '',
        secretId: '',
        model: '',
        availableModels: [],
        excludeBody: [],          // string[] — parameter names to exclude
        preset: currentPresets.preset,
        regexPreset: currentPresets.regexPreset,
        promptPostProcessing: currentPresets.promptPostProcessing,
        status: 'idle',
        statusMessage: '',
    };
    getConnections().push(conn);
    saveSettingsDebounced();
    return conn;
}

/**
 * Create a preset connection with real defaults (for first-run examples).
 */
function createPresetConnection(name, format) {
    const fmt = getFormatOption(format);
    if (!fmt) return null;
    const conn = {
        id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        format: fmt.value,
        endpoint: fmt.defaultEndpoint,
        apiKey: '',
        secretId: '',
        model: fmt.defaultModel,
        availableModels: [...fmt.defaultModels],
        excludeBody: [],
        status: 'idle',
        statusMessage: '',
    };
    getConnections().push(conn);
    return conn;
}

function updateConnection(id, partial) {
    const conn = getConnection(id);
    if (!conn) return;
    Object.assign(conn, partial);
    saveSettingsDebounced();
}

function deleteConnection(id) {
    const conns = getConnections();
    const idx = conns.findIndex(c => c.id === id);
    if (idx === -1 || conns.length <= 1) return;
    conns.splice(idx, 1);
    if (getActiveConnectionId() === id) {
        getSettings().activeConnectionId = conns[0]?.id || null;
    }
    saveSettingsDebounced();
}

function duplicateConnection(id) {
    const src = getConnection(id);
    if (!src) return null;
    const dup = {
        ...structuredClone(src),
        id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: `${src.name} (copy)`,
        status: 'idle',
        statusMessage: '',
    };
    getConnections().push(dup);
    saveSettingsDebounced();
    return dup;
}

function trimTrailingSlash(url) {
    return String(url || '').trim().replace(/\/+$/, '');
}

function getConnectionRequestSource(format) {
    return FORMAT_TO_SOURCE[format];
}

function getConnectionRequestBaseUrl(conn) {
    if (!conn) return '';
    if (conn.format === 'openai' || conn.format === 'anthropic') {
        return normalizeUrl(conn.endpoint, conn.format).normalized;
    }
    if (conn.format === 'gemini') {
        return trimTrailingSlash(conn.endpoint);
    }
    return '';
}

function matchesActiveConnectionRequest(conn, generateData) {
    if (!conn || !generateData) return false;
    if (generateData.chat_completion_source !== getConnectionRequestSource(conn.format)) return false;
    if (!conn.model || generateData.model !== conn.model) return false;

    const expectedBaseUrl = getConnectionRequestBaseUrl(conn);
    if (!expectedBaseUrl) return false;

    if (conn.format === 'openai') {
        return trimTrailingSlash(generateData.custom_url) === expectedBaseUrl;
    }

    return trimTrailingSlash(generateData.reverse_proxy) === expectedBaseUrl;
}

async function matchesActiveConnectionRuntime(conn) {
    if (!conn) return false;
    if (oai_settings.chat_completion_source !== getConnectionRequestSource(conn.format)) return false;

    let currentModel = '';
    if (conn.format === 'openai') {
        currentModel = oai_settings.custom_model;
    } else if (conn.format === 'anthropic') {
        currentModel = oai_settings.claude_model;
    } else if (conn.format === 'gemini') {
        currentModel = oai_settings.google_model;
    }

    if ((conn.model || '') !== (currentModel || '')) return false;

    const expectedBaseUrl = getConnectionRequestBaseUrl(conn);
    if (!expectedBaseUrl) return false;

    if (conn.format === 'openai') {
        if (trimTrailingSlash(oai_settings.custom_url) !== expectedBaseUrl) return false;

        // ApiHub owns CUSTOM additional parameters; if native UI/presets repopulate
        // them, force a runtime resync before request assembly.
        if (oai_settings.custom_include_body || oai_settings.custom_exclude_body || oai_settings.custom_include_headers) {
            return false;
        }
    } else if (trimTrailingSlash(oai_settings.reverse_proxy) !== expectedBaseUrl) {
        return false;
    }

    const secretKey = getSecretKeyForFormat(conn.format);
    if (secretKey) {
        const activeSecret = getActiveSecretEntry(secretKey);
        if (conn.secretId) {
            if (activeSecret?.id !== conn.secretId) return false;
        } else {
            const activeValue = await findSecret(secretKey);
            if ((activeValue ?? '') !== (conn.apiKey || '')) return false;
        }
    }

    if (conn.format === 'anthropic' || conn.format === 'gemini') {
        const { apiKey: runtimeApiKey } = await resolveConnectionApiKey(conn);
        if ((oai_settings.proxy_password || '') !== (runtimeApiKey || '')) return false;
    }

    return true;
}

/**
 * Sync the active connection's source/url/model/key into ST native runtime state
 * without replaying saved preset/regex/post-processing values.
 */
async function syncConnectionRuntime(conn, { markActive = false, triggerSourceChange = true } = {}) {
    if (!conn) return;
    if (markActive) {
        getSettings().activeConnectionId = conn.id;
    }

    await syncNativeSecretSlot(conn);
    const { apiKey: runtimeApiKey } = await resolveConnectionApiKey(conn);
    const { normalized } = normalizeUrl(conn.endpoint, conn.format);
    const targetSource = FORMAT_TO_SOURCE[conn.format];

    if (conn.format === 'openai') {
        oai_settings.custom_url = normalized;
        oai_settings.custom_model = conn.model;
    } else if (conn.format === 'anthropic') {
        oai_settings.reverse_proxy = normalized;
        oai_settings.proxy_password = runtimeApiKey || '';
        oai_settings.claude_model = conn.model;
    } else if (conn.format === 'gemini') {
        // Don't use normalizeUrl for gemini reverse_proxy — ST's makersuite backend
        // adds its own /{apiVersion}/ path, so we must pass the raw base URL
        oai_settings.reverse_proxy = conn.endpoint.replace(/\/+$/, '');
        oai_settings.proxy_password = runtimeApiKey || '';
        oai_settings.google_model = conn.model;
    }

    if (triggerSourceChange) {
        $('#chat_completion_source').val(targetSource).trigger('change');
    } else {
        // During live generation repair, avoid replaying ST's source-switch side effects.
        oai_settings.chat_completion_source = targetSource;
        $('#chat_completion_source').val(targetSource);
    }

    if (conn.format === 'openai') {
        oai_settings.custom_model = conn.model;
        $('#custom_model_id').val(conn.model);
    } else if (conn.format === 'anthropic') {
        oai_settings.claude_model = conn.model;
        $('#model_claude_select').val(conn.model);
    } else if (conn.format === 'gemini') {
        oai_settings.google_model = conn.model;
        $('#model_google_select').val(conn.model);
    }

    // Keep native custom YAML params empty. ApiHub applies exclusions via a unified pre-send hook.
    oai_settings.custom_include_body = '';
    oai_settings.custom_exclude_body = '';
    oai_settings.custom_include_headers = '';
}

/**
 * Pre-generation guard: if ST's native runtime has drifted away from the active
 * ApiHub connection (e.g. after a 429 or other error), repair it before ST
 * assembles the provider-specific request body.
 */
async function repairActiveConnectionBeforeGeneration(_type, _options, isDryRun) {
    if (nativeUIVisible || isDryRun) return;

    const conn = getActiveConnection();
    if (!conn || await matchesActiveConnectionRuntime(conn)) return;

    const expectedSource = FORMAT_TO_SOURCE[conn.format];
    console.warn(
        `[ApiHub] Pre-generation drift detected (source: ${oai_settings.chat_completion_source}→${expectedSource}, model: ${conn.model}). Repairing.`,
    );

    await syncConnectionRuntime(conn, { triggerSourceChange: false });
    saveSettingsDebounced();
}

/**
 * Apply GUI-selected exclusion keys before ST sends the chat-completions request.
 */
function applyActiveConnectionExclusions(generateData) {
    if (nativeUIVisible) return;

    const conn = getActiveConnection();
    const excludedKeys = conn?.excludeBody;

    if (!conn || !Array.isArray(excludedKeys) || excludedKeys.length === 0) return;
    if (!matchesActiveConnectionRequest(conn, generateData)) return;

    for (const key of excludedKeys) {
        if (key) delete generateData[key];
    }
}

// ── Slash command helper ──────────────────────────────────────────

/**
 * Execute a ST slash command silently (same mechanism as Connection Manager).
 * @param {string} command Command name (e.g. 'preset', 'regex-preset')
 * @param {string} argument Command argument (empty string = read current value)
 * @returns {Promise<string|undefined>} Command result (current value if argument is empty)
 */
async function runSlashCommand(command, argument) {
    if (!SlashCommandParser.commands[command]) return undefined;
    try {
        const args = {
            _scope: new SlashCommandScope(),
            _abortController: new SlashCommandAbortController(),
            _debugController: new SlashCommandDebugController(),
            _parserFlags: {},
            _hasUnnamedArgument: false,
            quiet: 'true',
        };
        return await SlashCommandParser.commands[command].callback(args, argument);
    } catch (err) {
        console.warn(`[ApiHub] Slash command /${command} ${argument} failed:`, err);
        return undefined;
    }
}

/**
 * Read current preset/regex-preset/prompt-post-processing from ST state.
 * @returns {Promise<{preset: string, regexPreset: string, promptPostProcessing: string}>}
 */
async function readCurrentPresets() {
    const preset = await runSlashCommand('preset', '') || '';
    const regexPreset = await runSlashCommand('regex-preset', '') || '';
    const promptPostProcessing = await runSlashCommand('prompt-post-processing', '') || '';
    return { preset, regexPreset, promptPostProcessing };
}

async function fetchSecretValue(secretKey, secretId) {
    try {
        const response = await fetch('/api/secrets/find', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ key: secretKey, id: secretId }),
        });

        if (!response.ok) {
            return { value: null, status: response.status };
        }

        const data = await response.json();
        return { value: data.value, status: response.status };
    } catch {
        return { value: null, status: null };
    }
}

async function readSecretValue(secretKey, secretId) {
    if (!secretKey || !secretId) return { value: null, status: null };
    const cacheKey = getSecretValueCacheKey(secretKey, secretId);
    if (secretValueCache.has(cacheKey)) {
        return { value: secretValueCache.get(cacheKey), status: 200 };
    }

    const { value, status } = await fetchSecretValue(secretKey, secretId);
    if (value !== null) {
        secretValueCache.set(cacheKey, value);
    }
    return { value, status };
}

async function findReusableEmptySecret(secretKey) {
    const secrets = secret_state[secretKey];
    if (!Array.isArray(secrets)) return null;

    const candidates = secrets.filter(secret => secret.label === EMPTY_SECRET_LABEL);
    for (const secret of candidates) {
        const { value } = await readSecretValue(secretKey, secret.id);
        if (value === '') {
            return secret;
        }
    }

    return null;
}

async function findSecretEntryByValue(secretKey, desiredValue) {
    if (!secretKey) return null;
    const secrets = secret_state[secretKey];
    if (!Array.isArray(secrets)) return null;

    for (const secret of secrets) {
        const { value } = await readSecretValue(secretKey, secret.id);
        if (value === desiredValue) {
            return secret;
        }
    }

    return null;
}

async function bindConnectionToActiveSecret(connectionId, secretKey, { clearWhenMissing = true, activateIfActive = false } = {}) {
    const conn = getConnection(connectionId);
    if (!conn) return false;

    const activeSecret = getActiveSecretEntry(secretKey);
    if (!activeSecret) {
        if (clearWhenMissing) {
            updateConnection(connectionId, { secretId: '' });
            if (getSelectedConnectionId() === connectionId) {
                renderConnectionDetails();
            }
        }
        return false;
    }

    const { value: secretValue, status } = await readSecretValue(secretKey, activeSecret.id);

    if (secretValue === null && requiresReadableSecretValue(conn.format)) {
        toastr.warning(getSecretReadFailureMessage(status));
        return false;
    }

    const nextApiKey = secretValue !== null ? secretValue : '';
    if (conn.secretId === activeSecret.id && (secretValue === null || conn.apiKey === nextApiKey)) {
        if (activateIfActive && getActiveConnectionId() === connectionId) {
            await activateConnection(connectionId);
        } else if (getSelectedConnectionId() === connectionId) {
            renderConnectionDetails();
        }
        return true;
    }

    const partial = {
        secretId: activeSecret.id,
        apiKey: nextApiKey,
    };

    if (secretValue === null && conn.secretId && conn.secretId !== activeSecret.id) {
        // OpenAI-compatible bindings can work without exposing the secret value.
        // Clear stale manual key so the connection follows the native slot only.
        partial.apiKey = '';
    }

    updateConnection(connectionId, partial);
    if (activateIfActive && getActiveConnectionId() === connectionId) {
        await activateConnection(connectionId);
    } else if (getSelectedConnectionId() === connectionId) {
        renderConnectionDetails();
    }
    return true;
}

function getFallbackApiKeyAfterMissingBinding(conn) {
    if (requiresReadableSecretValue(conn.format) && conn.apiKey) {
        return conn.apiKey;
    }

    return '';
}

async function resolveConnectionApiKey(conn) {
    const secretKey = getSecretKeyForFormat(conn.format);

    if (conn.secretId) {
        const secretEntry = getSecretEntry(secretKey, conn.secretId);
        if (!secretEntry) {
            const fallbackApiKey = getFallbackApiKeyAfterMissingBinding(conn);
            updateConnection(conn.id, { secretId: '', apiKey: fallbackApiKey });
            return { apiKey: fallbackApiKey, readStatus: 404 };
        } else {
            const { value: secretValue, status } = await readSecretValue(secretKey, conn.secretId);
            if (secretValue !== null) {
                return { apiKey: secretValue, readStatus: 200 };
            }
            return { apiKey: null, readStatus: status };
        }
    }

    return { apiKey: conn.apiKey || '', readStatus: 200 };
}

async function syncNativeSecretSlot(conn) {
    const secretKey = getSecretKeyForFormat(conn.format);
    if (!secretKey) return;

    if (conn.secretId) {
        const activeSecret = getActiveSecretEntry(secretKey);
        const boundSecret = getSecretEntry(secretKey, conn.secretId);
        if (!boundSecret) {
            updateConnection(conn.id, {
                secretId: '',
                apiKey: getFallbackApiKeyAfterMissingBinding(conn),
            });
            syncedSecretValues.delete(secretKey);
            return;
        }

        if (activeSecret?.id !== conn.secretId) {
            await rotateSecret(secretKey, conn.secretId);
        }

        syncedSecretValues.delete(secretKey);
        return;
    }

    const desiredValue = conn.apiKey || '';
    const activeSecret = getActiveSecretEntry(secretKey);
    const cachedValue = syncedSecretValues.get(secretKey);

    if (!desiredValue) {
        const activeValue = await findSecret(secretKey);
        if (activeValue === '') {
            syncedSecretValues.set(secretKey, '');
            return;
        }

        const reusableEmptySecret = await findReusableEmptySecret(secretKey);
        if (reusableEmptySecret) {
            if (activeSecret?.id !== reusableEmptySecret.id) {
                await rotateSecret(secretKey, reusableEmptySecret.id);
            }
            syncedSecretValues.set(secretKey, '');
            return;
        }

        if (activeSecret || cachedValue) {
            await writeSecret(secretKey, '', EMPTY_SECRET_LABEL, { allowEmpty: true });
        }
        syncedSecretValues.set(secretKey, '');
        return;
    }

    const reusableSecret = await findSecretEntryByValue(secretKey, desiredValue);
    if (reusableSecret) {
        if (activeSecret?.id !== reusableSecret.id) {
            await rotateSecret(secretKey, reusableSecret.id);
        }

        updateConnection(conn.id, {
            secretId: reusableSecret.id,
            apiKey: '',
        });
        syncedSecretValues.set(secretKey, desiredValue);
        return;
    }

    if (cachedValue === desiredValue && activeSecret) {
        return;
    }

    const activeValue = await findSecret(secretKey);
    if (activeValue !== null && activeValue === desiredValue) {
        syncedSecretValues.set(secretKey, desiredValue);
        return;
    }

    await writeSecret(secretKey, desiredValue);
    syncedSecretValues.set(secretKey, desiredValue);
}

// ── Core: Activate Connection → sync to oai_settings ───────────────

async function activateConnection(id) {
    const conn = getConnection(id);
    if (!conn) return;

    getSettings().activeConnectionId = id;

    // Apply preset FIRST (before connection fields) — preset may overwrite oai_settings
    // when bind_preset_to_connection is enabled. We reapply our fields after.
    if (conn.preset) await runSlashCommand('preset', conn.preset);
    await syncConnectionRuntime(conn);

    // Apply regex preset only when it actually changes (avoids chat reloads on every edit)
    const currentRegex = await runSlashCommand('regex-preset', '') || '';
    if ((conn.regexPreset || '') !== currentRegex) {
        await runSlashCommand('regex-preset', conn.regexPreset || 'none');
    }

    // Always apply prompt post-processing (reset to default if empty)
    await runSlashCommand('prompt-post-processing', conn.promptPostProcessing || 'none');

    saveSettingsDebounced();
    renderUI();
}

/**
 * Sync the selected connection into ST runtime without replaying saved
 * preset/regex/post-processing values. Used for plain model list edits.
 */
async function syncSelectedConnectionRuntime(conn) {
    if (!conn) return;
    await syncConnectionRuntime(conn, { markActive: true });
    saveSettingsDebounced();
    renderUI();
}

// ── Model fetching ─────────────────────────────────────────────────

let fetchAbortController = null;
let fetchId = 0;

function cancelFetch() {
    if (fetchAbortController) {
        fetchAbortController.abort();
        fetchAbortController = null;
    }
}

async function fetchModels() {
    const conn = getSelectedConnection();
    if (!conn) return;

    // Cancel any in-flight fetch
    cancelFetch();
    fetchAbortController = new AbortController();
    const { signal } = fetchAbortController;
    const myFetchId = ++fetchId;

    // Auto-timeout after 20 seconds
    const timeoutId = setTimeout(() => {
        if (fetchId === myFetchId) cancelFetch();
    }, 20000);

    // Show loading state on fetch button
    const fetchBtn = $('#apihub_btn_fetch_models');
    const originalHtml = fetchBtn.html();
    fetchBtn.html('<i class="fa-solid fa-spinner fa-spin"></i> 拉取中...').css('pointer-events', 'none');

    const cleanup = () => {
        clearTimeout(timeoutId);
        if (fetchId === myFetchId) {
            fetchAbortController = null;
            fetchBtn.html(originalHtml).css('pointer-events', '');
        }
    };

    try {
        // Only official Gemini needs native flow (ST's makersuite backend handles /models?key=)
        const isOfficialGemini = conn.format === 'gemini' && conn.endpoint.includes('googleapis.com');

        if (isOfficialGemini) {
            await activateConnection(conn.id);
            await fetchModelsViaNativeConnect(conn);
            cleanup();
            renderUI();
            return;
        }

        // Non-official endpoints: direct backend call with CUSTOM source (GET /models + Bearer)
        const { normalized } = normalizeUrl(conn.endpoint, 'openai'); // always normalize as openai for /v1/models

        const usesBoundOpenAiSecret = conn.format === 'openai' && !!conn.secretId;
        if (usesBoundOpenAiSecret) {
            await syncNativeSecretSlot(conn);
        } else {
            // Write API key to CUSTOM secret slot for this request
            const { apiKey: runtimeApiKey, readStatus } = await resolveConnectionApiKey(conn);
            if (runtimeApiKey) {
                await writeSecret(SECRET_KEYS.CUSTOM, runtimeApiKey);
            } else if (conn.secretId) {
                toastr.warning(getSecretReadFailureMessage(readStatus));
                cleanup();
                renderUI();
                return;
            }
        }

        const body = {
            chat_completion_source: chat_completion_sources.CUSTOM,
            custom_url: normalized,
        };

        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
            signal,
        });

        if (response.ok) {
            const result = await response.json();
            const rawModels = result?.data || [];
            const models = Array.isArray(rawModels)
                ? rawModels.map(m => m.id || m.name || String(m)).filter(Boolean)
                : [];

            if (models.length > 0) {
                updateConnection(conn.id, {
                    availableModels: [...new Set(models)],
                });
                if (!models.includes(conn.model)) {
                    updateConnection(conn.id, { model: models[0] });
                }
                toastr.success(`拉取到 ${models.length} 个模型`);
            } else {
                toastr.warning('未拉取到模型');
            }
        } else {
            const errText = await response.text().catch(() => '');
            toastr.error(`拉取失败: ${response.status} ${errText.slice(0, 100)}`);
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            if (fetchId !== myFetchId) return; // cancelled by new fetch
            toastr.warning('拉取超时');
        } else {
            toastr.error(err.message || '拉取失败');
        }
    }

    cleanup();
    renderUI();
}

/**
 * Fetch models via ST's native Connect button flow.
 * Used for Gemini (makersuite) which has special URL construction in the backend.
 */
async function fetchModelsViaNativeConnect(conn) {
    // Trigger the native Connect button
    $('#api_button_openai').trigger('click');

    // Poll for online status change (ST updates #online_status_text)
    let waited = 0;
    const interval = 300;
    const timeout = 15000;

    await new Promise((resolve) => {
        const check = () => {
            waited += interval;
            const statusText = $('#online_status_text').text();
            if ((statusText && !statusText.includes('No connection') && !statusText.includes('...')) || waited >= timeout) {
                resolve();
                return;
            }
            setTimeout(check, interval);
        };
        setTimeout(check, interval);
    });

    // Check the model select that ST populates for makersuite
    const googleModels = $('#model_google_select option').map(function () {
        return $(this).val();
    }).get().filter(Boolean);

    if (googleModels.length > 0) {
        updateConnection(conn.id, {
            availableModels: [...new Set(googleModels)],
        });
        if (!googleModels.includes(conn.model)) {
            updateConnection(conn.id, { model: googleModels[0] });
        }
        toastr.success(`拉取到 ${googleModels.length} 个模型`);
    } else {
        toastr.warning('未拉取到模型');
    }

    renderUI();
}

// ── Native Secret Integration ─────────────────────────────────────

/**
 * Open ST's native key manager dialog for the current connection's format.
 */
function openNativeKeyManager(format) {
    const secretKey = getSecretKeyForFormat(format);
    if (!secretKey) return;
    const btn = $(`<div class="manage-api-keys" data-key="${secretKey}" style="display:none;"></div>`);
    $('body').append(btn);
    btn.trigger('click');
    btn.remove();
}

// ── Import / Export ────────────────────────────────────────────────

function exportConnections() {
    const data = getConnections().map(c => {
        const clean = { ...c };
        return clean;
    });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `apihub-backup-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function importConnections() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const raw = JSON.parse(text);
            // Reject debug exports (they contain masked keys and native config)
            if (raw?.native) {
                toastr.warning('这是调试导出文件，不能用于导入。请使用"导出"生成的备份文件。');
                return;
            }
            // Support: plain array or {apiHub: {connections: []}} (legacy)
            const data = Array.isArray(raw) ? raw : (raw?.apiHub?.connections || []);
            if (!Array.isArray(data) || data.length === 0) {
                toastr.warning('导入失败：文件中没有连接配置');
                return;
            }
            const validFormats = FORMAT_OPTIONS.map(f => f.value);
            let imported = 0;
            for (const c of data) {
                if (!c.name || !c.format || !validFormats.includes(c.format)) continue;
                c.id = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                c.status = 'idle';
                c.statusMessage = '';
                c.apiKey = c.apiKey || '';
                c.secretId = c.secretId || '';
                c.endpoint = c.endpoint || '';
                c.model = c.model || '';
                c.availableModels = Array.isArray(c.availableModels) ? c.availableModels : [];
                c.excludeBody = Array.isArray(c.excludeBody) ? c.excludeBody : [];
                delete c.includeBody;
                delete c.includeHeaders;
                c.preset = c.preset || '';
                c.regexPreset = c.regexPreset || '';
                c.promptPostProcessing = c.promptPostProcessing || '';
                const secretKey = getSecretKeyForFormat(c.format);
                if (!getSecretEntry(secretKey, c.secretId)) {
                    c.secretId = '';
                }
                getConnections().push(c);
                imported++;
            }
            if (imported === 0) {
                toastr.warning('导入失败：未找到有效的连接配置');
                return;
            }
            toastr.success(`已导入 ${imported} 个连接配置`);
            saveSettingsDebounced();
            renderUI();
        } catch {
            toastr.error('导入失败：文件格式无效');
        }
    };
    input.click();
}

function exportDebug() {
    const data = {
        apiHub: {
            connections: getConnections().map(c => ({ ...c, apiKey: c.apiKey ? '***' : '' })),
            activeConnectionId: getActiveConnectionId(),
        },
        native: {
            chat_completion_source: oai_settings.chat_completion_source,
            custom_url: oai_settings.custom_url,
            custom_model: oai_settings.custom_model,
            reverse_proxy: oai_settings.reverse_proxy,
            claude_model: oai_settings.claude_model,
            google_model: oai_settings.google_model,
            proxies: proxies.map(p => ({ name: p.name, url: p.url, hasPassword: !!p.password })),
            connectionManagerProfiles: (extension_settings?.connectionManager?.profiles || []).map(p => {
                const clean = { ...p };
                if (clean['secret-id']) clean['secret-id'] = '***';
                return clean;
            }),
        },
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `apihub-debug-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function getSecretManagerKey(manager) {
    return manager.find('.secretKeyManagerInfo code').text().trim();
}

function getSecretManagerItems(manager) {
    return manager.find('.secretKeyManagerList .secretKeyManagerItem');
}

function getSecretManagerItemId(item) {
    return item.find('.secretKeyManagerItemId').text().trim();
}

function getSecretManagerItemLabel(item) {
    return item.find('.secretKeyManagerItemHeader strong').first().text().trim();
}

async function copySecretManagerText(text, successMessage) {
    try {
        await copyText(text);
        toastr.info(successMessage);
    } catch {
        toastr.error('复制失败，请检查浏览器权限');
    }
}

function getSecretManagerRenderSignature(secretKey) {
    const secrets = Array.isArray(secret_state[secretKey]) ? secret_state[secretKey] : [];
    const selection = [...getBulkSelectionForKey(secretKey)].sort();
    return JSON.stringify({
        secrets: secrets.map(secret => ({
            id: secret.id,
            label: secret.label || '',
            value: secret.value || '',
            active: !!secret.active,
        })),
        selection,
    });
}

function updateSecretManagerBulkUi(manager) {
    const secretKey = getSecretManagerKey(manager);
    if (!secretKey) return;

    const selection = getBulkSelectionForKey(secretKey);
    let selectedVisibleCount = 0;
    const visibleIds = new Set();
    const items = getSecretManagerItems(manager);
    items.each(function () {
        const item = $(this);
        const id = getSecretManagerItemId(item);
        visibleIds.add(id);
        const checked = selection.has(id);
        item.find('.apihub_secret_bulk_checkbox').prop('checked', checked);
        item.toggleClass('apihub_secret_selected', checked);
        if (checked) selectedVisibleCount++;
    });

    for (const id of [...selection]) {
        if (!visibleIds.has(id)) {
            selection.delete(id);
        }
    }

    manager.find('.apihub_secret_bulk_count').text(`${selectedVisibleCount} 已选`);
    const hasSelection = selection.size > 0;
    manager.find('.apihub_secret_bulk_export, .apihub_secret_bulk_delete, .apihub_secret_bulk_clear').toggleClass('disabled', !hasSelection);
}

function buildSecretManagerItem(manager, secretKey, secret) {
    const selection = getBulkSelectionForKey(secretKey);
    const checked = selection.has(secret.id);
    const item = $('<div class="secretKeyManagerItem"></div>')
        .attr('data-apihub-bulk-patched', 'true')
        .toggleClass('active', !!secret.active)
        .toggleClass('apihub_secret_selected', checked);
    const toggle = $(`
        <label class="apihub_secret_bulk_toggle">
            <input type="checkbox" class="apihub_secret_bulk_checkbox" />
        </label>
    `);
    toggle.find('input').prop('checked', checked).on('change', function () {
        if ($(this).prop('checked')) {
            selection.add(secret.id);
        } else {
            selection.delete(secret.id);
        }
        updateSecretManagerBulkUi(manager);
    });

    const info = $('<div class="secretKeyManagerItemInfo"></div>');
    const header = $('<div class="secretKeyManagerItemHeader"></div>');
    $('<strong></strong>').text(secret.label || '').appendTo(header);
    $('<small></small>').text(secret.value || '').appendTo(header);
    const subtitle = $('<div class="secretKeyManagerItemSubtitle"></div>');
    subtitle.append('<strong>ID:</strong>');
    const idSpan = $('<span class="secretKeyManagerItemId" title="Copy ID"></span>').text(secret.id);
    idSpan.on('click', async () => {
        await copySecretManagerText(secret.id, '密钥 ID 已复制');
    });
    subtitle.append(idSpan);
    info.append(header, subtitle);

    const actions = $('<div class="secretKeyManagerItemActions"></div>');
    const row1 = $('<div class="secretKeyManagerItemActionsRow"></div>');
    const rotateBtn = $('<button class="menu_button menu_button_icon" type="button" title="Select"><i class="fa-fw fa-solid fa-check"></i></button>')
        .toggleClass('disabled', !!secret.active)
        .on('click', async function () {
            if ($(this).hasClass('disabled')) return;
            await rotateSecret(secretKey, secret.id);
            renderSecretManagerItems(manager);
        });
    const copyBtn = $('<button class="menu_button menu_button_icon" type="button" title="Copy"><i class="fa-fw fa-solid fa-copy"></i></button>')
        .on('click', async () => {
            const { value, status } = await fetchSecretValue(secretKey, secret.id);
            if (value === null) {
                toastr.error(getSecretReadFailureMessage(status));
                return;
            }
            await copySecretManagerText(value, '密钥值已复制');
        });
    row1.append(rotateBtn, copyBtn);

    const row2 = $('<div class="secretKeyManagerItemActionsRow"></div>');
    const renameBtn = $('<button class="menu_button menu_button_icon" type="button" title="Rename"><i class="fa-fw fa-solid fa-pen-to-square"></i></button>')
        .on('click', async () => {
            const label = await callGenericPopup('输入新的密钥标签：', POPUP_TYPE.INPUT, secret?.label || '');
            if (label === null) return;
            const nextLabel = String(label).trim();
            if (!nextLabel) return;
            await renameSecret(secretKey, secret.id, nextLabel);
            renderSecretManagerItems(manager);
        });
    const deleteBtn = $('<button class="menu_button menu_button_icon" type="button" title="Delete"><i class="fa-fw fa-solid fa-trash"></i></button>')
        .on('click', async () => {
            const confirmed = await callGenericPopup(`确定删除密钥“${secret?.label || secret.id}”？此操作不可撤销。`, POPUP_TYPE.CONFIRM);
            if (!confirmed) return;
            await deleteSecret(secretKey, secret.id);
            selection.delete(secret.id);
            renderSecretManagerItems(manager);
        });
    row2.append(renameBtn, deleteBtn);

    actions.append(row1, row2);
    item.append(toggle, info, actions);
    return item;
}

function renderSecretManagerItems(manager) {
    const secretKey = getSecretManagerKey(manager);
    if (!secretKey) return;

    const list = manager.find('.secretKeyManagerList');
    if (!list.length) return;
    const signature = getSecretManagerRenderSignature(secretKey);
    if (manager.attr('data-apihub-bulk-signature') === signature) {
        updateSecretManagerBulkUi(manager);
        return;
    }

    const secrets = Array.isArray(secret_state[secretKey]) ? secret_state[secretKey] : [];
    const previousScrollTop = list.scrollTop();
    const items = secrets.map(secret => buildSecretManagerItem(manager, secretKey, secret));
    list.empty().append(items).scrollTop(previousScrollTop);
    manager.find('.secretKeyManagerListEmpty').toggle(secrets.length === 0);
    manager.attr('data-apihub-bulk-signature', signature);
    updateSecretManagerBulkUi(manager);
}

function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

async function exportSelectedSecrets(manager) {
    const secretKey = getSecretManagerKey(manager);
    const selection = getBulkSelectionForKey(secretKey);
    const ids = [...selection];
    if (ids.length === 0) {
        toastr.warning('请先选择要导出的密钥');
        return;
    }

    const itemsById = new Map();
    getSecretManagerItems(manager).each(function () {
        const item = $(this);
        itemsById.set(getSecretManagerItemId(item), item);
    });

    const secrets = [];
    for (const id of ids) {
        const item = itemsById.get(id);
        if (!item) continue;
        const { value, status } = await fetchSecretValue(secretKey, id);
        if (value === null) {
            toastr.error(getSecretReadFailureMessage(status));
            return;
        }

        secrets.push({
            id,
            label: getSecretManagerItemLabel(item),
            value,
            active: item.hasClass('active'),
        });
    }

    downloadJson(`secrets-${secretKey}-${Date.now()}.json`, {
        key: secretKey,
        exportedAt: new Date().toISOString(),
        secrets,
    });
    toastr.success(`已导出 ${secrets.length} 个密钥`);
}

async function importSecretsIntoManager(manager) {
    const secretKey = getSecretManagerKey(manager);
    if (!secretKey) return;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const raw = JSON.parse(await file.text());
            const secrets = Array.isArray(raw) ? raw : raw?.secrets;
            if (!Array.isArray(secrets) || secrets.length === 0) {
                toastr.warning('导入失败：文件中没有密钥条目');
                return;
            }

            if (raw?.key && raw.key !== secretKey) {
                toastr.warning(`导入失败：该文件属于 ${raw.key}，当前密钥槽是 ${secretKey}`);
                return;
            }

            let imported = 0;
            let reused = 0;
            let activeImportedId = '';
            const selectedIds = new Set();
            const existingByValue = new Map();
            const existingSecrets = Array.isArray(secret_state[secretKey]) ? secret_state[secretKey] : [];
            for (const existingSecret of existingSecrets) {
                const { value } = await readSecretValue(secretKey, existingSecret.id);
                if (value !== null && !existingByValue.has(value)) {
                    existingByValue.set(value, existingSecret.id);
                }
            }

            for (const secret of secrets) {
                const value = typeof secret?.value === 'string' ? secret.value : null;
                if (value === null) continue;
                const label = typeof secret?.label === 'string' ? secret.label.trim() : '';
                const existingId = existingByValue.get(value);
                if (existingId) {
                    reused++;
                    selectedIds.add(existingId);
                    if (secret.active) {
                        activeImportedId = existingId;
                    }
                    continue;
                }
                const id = await writeSecret(secretKey, value, label, { allowEmpty: true });
                if (id) {
                    imported++;
                    existingByValue.set(value, id);
                    selectedIds.add(id);
                    if (secret.active) {
                        activeImportedId = id;
                    }
                }
            }

            if (activeImportedId) {
                await rotateSecret(secretKey, activeImportedId);
            }

            if (imported > 0 || reused > 0) {
                const selection = getBulkSelectionForKey(secretKey);
                selection.clear();
                for (const id of selectedIds) {
                    selection.add(id);
                }
                renderSecretManagerItems(manager);
                const message = reused > 0
                    ? `已导入 ${imported} 个密钥，复用 ${reused} 个已有密钥`
                    : `已导入 ${imported} 个密钥`;
                toastr.success(message);
            } else {
                toastr.warning('导入失败：没有有效密钥条目');
            }
        } catch {
            toastr.error('导入失败：文件格式无效');
        }
    };
    input.click();
}

async function deleteSelectedSecrets(manager) {
    const secretKey = getSecretManagerKey(manager);
    const selection = getBulkSelectionForKey(secretKey);
    const ids = [...selection];
    if (ids.length === 0) {
        toastr.warning('请先选择要删除的密钥');
        return;
    }

    const confirmed = await callGenericPopup(`确定删除选中的 ${ids.length} 个密钥？此操作不可撤销。`, POPUP_TYPE.CONFIRM);
    if (!confirmed) return;

    for (const id of ids) {
        await deleteSecret(secretKey, id);
    }
    selection.clear();
    renderSecretManagerItems(manager);
    toastr.success(`已删除 ${ids.length} 个密钥`);
}

function mountSecretManagerToolbar(manager) {
    if (manager.attr('data-apihub-bulk-toolbar') === 'true') return;
    manager.attr('data-apihub-bulk-toolbar', 'true');

    const toolbar = $(`
        <div class="apihub_secret_bulk_bar">
            <div class="apihub_secret_bulk_group">
                <button class="menu_button menu_button_icon apihub_secret_bulk_select_all" type="button">
                    <i class="fa-solid fa-check-double"></i>
                    <span>全选</span>
                </button>
                <button class="menu_button menu_button_icon apihub_secret_bulk_clear disabled" type="button">
                    <i class="fa-solid fa-xmark"></i>
                    <span>清空</span>
                </button>
            </div>
            <div class="apihub_secret_bulk_group">
                <button class="menu_button menu_button_icon apihub_secret_bulk_import" type="button">
                    <i class="fa-solid fa-file-import"></i>
                    <span>导入</span>
                </button>
                <button class="menu_button menu_button_icon apihub_secret_bulk_export disabled" type="button">
                    <i class="fa-solid fa-file-export"></i>
                    <span>导出</span>
                </button>
                <button class="menu_button menu_button_icon apihub_secret_bulk_delete disabled" type="button">
                    <i class="fa-solid fa-trash-can"></i>
                    <span>删除</span>
                </button>
            </div>
            <div class="apihub_secret_bulk_count">0 已选</div>
        </div>
    `);

    toolbar.find('.apihub_secret_bulk_select_all').on('click', () => {
        const secretKey = getSecretManagerKey(manager);
        const selection = getBulkSelectionForKey(secretKey);
        getSecretManagerItems(manager).each(function () {
            selection.add(getSecretManagerItemId($(this)));
        });
        updateSecretManagerBulkUi(manager);
    });

    toolbar.find('.apihub_secret_bulk_clear').on('click', function () {
        if ($(this).hasClass('disabled')) return;
        const secretKey = getSecretManagerKey(manager);
        getBulkSelectionForKey(secretKey).clear();
        updateSecretManagerBulkUi(manager);
    });

    toolbar.find('.apihub_secret_bulk_export').on('click', async function () {
        if ($(this).hasClass('disabled')) return;
        await exportSelectedSecrets(manager);
    });

    toolbar.find('.apihub_secret_bulk_import').on('click', async () => {
        await importSecretsIntoManager(manager);
    });

    toolbar.find('.apihub_secret_bulk_delete').on('click', async function () {
        if ($(this).hasClass('disabled')) return;
        await deleteSelectedSecrets(manager);
    });

    manager.find('.secretKeyManagerHeader').after(toolbar);
}

function enhanceSecretManager(manager) {
    if (!manager?.length) return;
    mountSecretManagerToolbar(manager);
    renderSecretManagerItems(manager);
}

function refreshOpenSecretManagers(secretKey = '') {
    $('dialog .secretKeyManager').each(function () {
        const manager = $(this);
        if (secretKey && getSecretManagerKey(manager) !== secretKey) return;
        enhanceSecretManager(manager);
    });
}

function initSecretManagerPatch() {
    refreshOpenSecretManagers();
    if (secretManagerObserver) return;

    secretManagerObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof Element)) continue;

                if (node.matches('.secretKeyManager')) {
                    enhanceSecretManager($(node));
                    continue;
                }

                const managers = node.querySelectorAll?.('.secretKeyManager');
                if (!managers?.length) continue;
                managers.forEach(manager => enhanceSecretManager($(manager)));
            }
        }
    });
    secretManagerObserver.observe(document.body, { childList: true, subtree: true });
}

// ── Migration from native ST config ───────────────────────────────

/** Map ST chat_completion_source / CM profile api values to our format */
const SOURCE_TO_FORMAT = {
    [chat_completion_sources.CUSTOM]: 'openai',
    [chat_completion_sources.CLAUDE]: 'anthropic',
    [chat_completion_sources.MAKERSUITE]: 'gemini',
    'google': 'gemini', // CM profiles store "google" for Google AI Studio
};

/**
 * Detect existing native ST connection configs and migrate them into ApiHub.
 *
 * Primary data source: Connection Manager profiles (extension_settings.connectionManager.profiles).
 * Each profile contains: api (source), api-url (endpoint), model, proxy (preset name), secret-id, etc.
 *
 * Only migrates profiles whose api maps to our 3 supported formats (custom/claude/makersuite).
 * Unsupported sources (openrouter, vertexai, etc.) are skipped.
 */
async function migrateFromNative() {
    const migrated = [];
    const skippedSecretBindings = [];
    const dedupeKeys = new Set(getConnections().map(c => getConnectionIdentityKey(c)));

    function getCredentialIdentity({ secretId = '', apiKey = '' } = {}) {
        if (secretId) return `secret:${secretId}`;
        if (apiKey) return `manual:${apiKey}`;
        return 'manual:';
    }

    function getConnectionIdentityKey(conn) {
        return `${conn.format}|${conn.endpoint}|${getCredentialIdentity({
            secretId: conn.secretId,
            apiKey: conn.apiKey,
        })}`;
    }

    function isDuplicate(format, endpoint, identity) {
        return dedupeKeys.has(`${format}|${endpoint}|${identity}`);
    }

    function makeConn(name, format, endpoint, apiKey, model) {
        return {
            id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name,
            format,
            endpoint,
            apiKey: apiKey || '',
            secretId: '',
            model: model || '',
            availableModels: model ? [model] : [],
            excludeBody: [],
            status: 'idle',
            statusMessage: '',
        };
    }

    function addConn(conn) {
        getConnections().push(conn);
        dedupeKeys.add(getConnectionIdentityKey(conn));
        migrated.push(conn);
    }

    // 1. Migrate from Connection Manager profiles (primary source)
    const cmProfiles = extension_settings?.connectionManager?.profiles;
    const cmReferencedProxyNames = new Set(); // track proxy names used by CM profiles

    if (Array.isArray(cmProfiles)) {
        for (const profile of cmProfiles) {
            const format = SOURCE_TO_FORMAT[profile.api];
            if (!format) continue; // unsupported source, skip

            // Track referenced proxy names
            if (profile.proxy) cmReferencedProxyNames.add(profile.proxy);

            // Resolve endpoint
            let endpoint = '';

            // For non-openai formats with a proxy, the proxy URL is the real endpoint
            // (api-url may be a stale snapshot from when the profile was saved)
            if (profile.proxy && format !== 'openai') {
                const proxyPreset = proxies.find(p => p.name === profile.proxy);
                if (proxyPreset && proxyPreset.url) {
                    endpoint = proxyPreset.url.trim();
                }
            }

            // Fall back to api-url (always used for openai/custom, fallback for others)
            if (!endpoint) {
                endpoint = (profile['api-url'] || '').trim();
            }

            // Fallback to default endpoint
            if (!endpoint) {
                endpoint = getFormatOption(format).defaultEndpoint;
            }

            // Get API key from proxy password (findSecret requires allowKeysExposure)
            let apiKey = '';
            if (profile.proxy) {
                const proxyPreset = proxies.find(p => p.name === profile.proxy);
                if (proxyPreset && proxyPreset.password) {
                    apiKey = proxyPreset.password;
                }
            }

            const identity = getCredentialIdentity({
                secretId: profile['secret-id'],
                apiKey,
            });
            if (isDuplicate(format, endpoint, identity)) continue;

            const conn = makeConn(
                profile.name || `${getFormatOption(format).label} (migrated)`,
                format,
                endpoint,
                apiKey,
                profile.model || '',
            );

            if (profile['secret-id']) {
                const secretKey = getSecretKeyForFormat(format);
                const secretEntry = getSecretEntry(secretKey, profile['secret-id']);

                if (!secretEntry) {
                    console.warn(`[ApiHub] Skipped migrating missing native secret binding for "${conn.name}".`);
                } else if (requiresReadableSecretValue(format)) {
                    const { value: secretValue } = await readSecretValue(secretKey, secretEntry.id);
                    if (secretValue !== null) {
                        conn.secretId = secretEntry.id;
                        conn.apiKey = '';
                    } else {
                        skippedSecretBindings.push(conn.name);
                    }
                } else {
                    conn.secretId = secretEntry.id;
                    conn.apiKey = '';
                }
            }

            // Carry over associated presets from CM profile
            if (profile.preset) conn.preset = profile.preset;
            if (profile['regex-preset']) conn.regexPreset = profile['regex-preset'];
            if (profile['prompt-post-processing']) conn.promptPostProcessing = profile['prompt-post-processing'];

            addConn(conn);
        }
    }

    // 2. Migrate proxy presets NOT already referenced by CM profiles
    for (const proxy of proxies) {
        if (!proxy.url || proxy.name === 'None' || !proxy.name) continue;
        if (cmReferencedProxyNames.has(proxy.name)) continue; // already covered by CM
        const url = proxy.url.trim();
        if (!url) continue;
        if (isDuplicate('openai', url, getCredentialIdentity({ apiKey: proxy.password }))) continue;
        addConn(makeConn(proxy.name, 'openai', url, proxy.password, ''));
    }

    if (migrated.length > 0) {
        const targetConn = migrated[migrated.length - 1];
        saveSettingsDebounced();
        renderUI();
        $('#apihub_connection_select').val(targetConn.id);
        renderConnectionDetails();
        renderUrlPreview();
        renderCustomParams();
        await activateConnection(targetConn.id);
        toastr.success(`已迁移 ${migrated.length} 个连接配置：${migrated.map(c => c.name).join('、')}`);
        if (skippedSecretBindings.length > 0) {
            toastr.warning(`以下连接未迁移原生密钥绑定，已保留原有手动/代理密钥：${skippedSecretBindings.join('、')}。只有当前实例允许前端读取原生密钥时，才可自动绑定 secretId。`);
        }
    } else {
        toastr.info('未检测到可迁移的原生连接配置');
    }

    return migrated;
}

// ── UI Rendering ───────────────────────────────────────────────────

function renderUI() {
    renderConnectionSelect();
    renderConnectionDetails();
    renderUrlPreview();
    renderCustomParams();
}

function renderConnectionSelect() {
    const select = $('#apihub_connection_select');
    const conns = getConnections();
    const activeId = getActiveConnectionId();
    const selectedId = select.val();

    select.empty();
    for (const c of conns) {
        const suffix = c.id === activeId ? ' ⚡' : '';
        select.append($('<option>', { value: c.id, text: `${c.name}${suffix}` }));
    }

    // Preserve selection or select active
    if (conns.find(c => c.id === selectedId)) {
        select.val(selectedId);
    } else if (activeId) {
        select.val(activeId);
    }
}

function renderConnectionDetails() {
    const conn = getSelectedConnection();
    if (!conn) return;

    const activeId = getActiveConnectionId();
    const fmt = getFormatOption(conn.format);

    // Format
    $('#apihub_format_select').val(conn.format);

    // Endpoint — dynamic placeholder based on format
    $('#apihub_endpoint').val(conn.endpoint).attr('placeholder', fmt ? fmt.defaultEndpoint : 'https://...');

    // API key
    const boundSecretLabel = getConnectionBoundSecretLabel(conn);
    const secretKey = getSecretKeyForFormat(conn.format);
    const activeSecretLabel = getActiveSecretLabel(secretKey);
    const placeholder = boundSecretLabel
        ? `已绑定密钥: ${boundSecretLabel}`
        : (activeSecretLabel ? `密钥库: ${activeSecretLabel}` : 'sk-...');
    $('#apihub_apikey').val(conn.secretId ? '' : conn.apiKey).attr('placeholder', placeholder);

    // Model select
    renderModelList(conn);

    // Active badge — always show since switch = activate
    $('#apihub_active_badge').toggle(conn.id === activeId);
}

function renderModelList(conn) {
    conn = conn || getSelectedConnection();
    if (!conn) return;

    const select = $('#apihub_model_select');
    select.empty();

    if (conn.availableModels.length === 0) {
        select.append($('<option>', { value: '', text: '输入模型名或 Fetch 拉取', disabled: true, selected: true }));
    }

    for (const m of conn.availableModels) {
        select.append($('<option>', { value: m, text: m }));
    }

    // Select current model
    if (conn.model && conn.availableModels.includes(conn.model)) {
        select.val(conn.model);
    } else if (conn.model) {
        select.prepend($('<option>', { value: conn.model, text: conn.model }));
        select.val(conn.model);
    }

    // Show/hide delete button based on model count
    $('#apihub_btn_delete_model').toggle(conn.availableModels.length > 0);
}

function renderUrlPreview() {
    const conn = getSelectedConnection();
    if (!conn || !conn.endpoint) {
        $('#apihub_url_preview').hide();
        return;
    }

    const preview = computeUrlPreview(conn.format, conn.endpoint, conn.model);
    if (!preview) {
        $('#apihub_url_preview').hide();
        return;
    }

    if (preview.literal) {
        $('#apihub_preview_chat_url').text(preview.chatUrl);
        $('#apihub_preview_literal').show();
    } else {
        $('#apihub_preview_chat_url').text(preview.chatUrl);
        $('#apihub_preview_literal').hide();
    }

    $('#apihub_url_preview').show();
}

// ── Exclusion Params Rendering ────────────────────────────────────

function renderCustomParams(conn) {
    conn = conn || getSelectedConnection();
    if (!conn) return;

    // Ensure arrays exist (migration for old connections)
    conn.excludeBody = conn.excludeBody || [];
    renderExcludeBody(conn);
}

function renderExcludeBody(conn) {
    $('#apihub_exclude_body input[type="checkbox"]').each(function () {
        $(this).prop('checked', conn.excludeBody.includes($(this).val()));
    });
}

// ── Hide native UI elements ────────────────────────────────────────

let nativeUIVisible = false;

function applyNativeUIVisibility() {
    const sourceSelect = $('#chat_completion_source');
    const sourceForms = '#openai_form, #claude_form, #makersuite_form, #custom_form';
    $('#apihub_btn_migrate').toggle(!nativeUIVisible);

    if (nativeUIVisible) {
        // Show native, hide ApiHub content (keep branding bar visible for toggle)
        $('#apihub_container').children().not('.apihub_branding').hide();
        sourceSelect.prevAll('h4').first().show();
        sourceSelect.show();
        $('#openai_reverse_proxy').closest('.inline-drawer').show();
        $('#ReverseProxyWarningMessage').show();
        $(sourceForms).show();
        $('#customize_additional_parameters').show();
        $('#connection_profiles').closest('.wide100p').show();
        // Trigger toggleChatCompletionForms to show correct source form
        sourceSelect.trigger('change');
    } else {
        // Show ApiHub, hide native
        $('#apihub_container').children().show();
        // Re-hide inline rows and collapsed panels that should only show on interaction
        $('#apihub_rename_row, #apihub_new_row, #apihub_add_model_row').hide();
        if (!$('#apihub_params_toggle .apihub_collapse_icon').hasClass('open')) {
            $('#apihub_params_panel').hide();
        }
        sourceSelect.prevAll('h4').first().hide();
        sourceSelect.hide();
        $('#openai_reverse_proxy').closest('.inline-drawer').hide();
        $('#ReverseProxyWarningMessage').hide();
        $(sourceForms).hide();
        $('#customize_additional_parameters').hide();
        $('#connection_profiles').closest('.wide100p').hide();
    }
}

function hideNativeUI() {
    nativeUIVisible = false;
    applyNativeUIVisibility();

    // Hide "Additional Parameters" button (inside prompt_post_processing_form, has data-source="custom")
    $('#customize_additional_parameters').hide();

    // Re-apply after source changes (toggleChatCompletionForms re-shows data-source elements)
    $(document).on('change', '#chat_completion_source', () => {
        if (!nativeUIVisible) {
            const sourceForms = '#openai_form, #claude_form, #makersuite_form, #custom_form';
            $('#chat_completion_source').prevAll('h4').first().hide();
            $('#chat_completion_source').hide();
            $('#openai_reverse_proxy').closest('.inline-drawer').hide();
            $('#ReverseProxyWarningMessage').hide();
            $(sourceForms).hide();
            $('#customize_additional_parameters').hide();
        }
    });
}

// ── Event Binding ──────────────────────────────────────────────────

function bindEvents() {
    // Toggle native/ApiHub UI
    $('#apihub_btn_toggle_native').on('click', () => {
        nativeUIVisible = !nativeUIVisible;
        applyNativeUIVisibility();
        const btn = $('#apihub_btn_toggle_native');
        if (nativeUIVisible) {
            btn.addClass('active').html('<i class="fa-solid fa-arrows-rotate"></i> API Hub');
        } else {
            btn.removeClass('active').html('<i class="fa-solid fa-arrows-rotate"></i> Native UI');
        }
    });

    // Connection selector — switch = activate
    $('#apihub_connection_select').on('change', async () => {
        pendingSecretBinding = null;
        cancelFetch(); // cancel any in-flight model fetch
        const conn = getSelectedConnection();
        if (!conn) return;
        renderConnectionDetails();
        renderUrlPreview();
        renderCustomParams();
        await activateConnection(conn.id);
    });

    // Format change → activate immediately
    $('#apihub_format_select').on('change', async function () {
        const conn = getSelectedConnection();
        if (!conn) return;
        const format = $(this).val();
        const { apiKey: runtimeApiKey } = await resolveConnectionApiKey(conn);
        updateConnection(conn.id, {
            format,
            apiKey: runtimeApiKey || '',
            secretId: '',
            model: '',
            availableModels: [],
        });
        renderConnectionDetails();
        renderUrlPreview();
        await activateConnection(conn.id);
    });

    // Endpoint input → live preview + debounced activate
    let endpointActivateTimer = null;
    $('#apihub_endpoint').on('input', function () {
        pendingSecretBinding = null;
        const conn = getSelectedConnection();
        if (!conn) return;
        updateConnection(conn.id, { endpoint: $(this).val() });
        renderUrlPreview();
        // Debounce activation to avoid thrashing on every keystroke
        clearTimeout(endpointActivateTimer);
        endpointActivateTimer = setTimeout(() => activateConnection(conn.id), 600);
    });

    // API key input → debounced activate
    let keyActivateTimer = null;
    $('#apihub_apikey').on('input', function () {
        pendingSecretBinding = null;
        const conn = getSelectedConnection();
        if (!conn) return;
        updateConnection(conn.id, { apiKey: $(this).val(), secretId: '' });
        clearTimeout(keyActivateTimer);
        keyActivateTimer = setTimeout(() => activateConnection(conn.id), 600);
    });

    // Toggle key visibility
    $('#apihub_btn_show_key').on('click', () => {
        const input = $('#apihub_apikey');
        const icon = $('#apihub_btn_show_key i');
        if (input.attr('type') === 'password') {
            input.attr('type', 'text');
            icon.removeClass('fa-eye').addClass('fa-eye-slash');
        } else {
            input.attr('type', 'password');
            icon.removeClass('fa-eye-slash').addClass('fa-eye');
        }
    });

    // Model change → runtime sync without replaying saved preset state
    $('#apihub_model_select').on('change', async function () {
        const conn = getSelectedConnection();
        if (!conn) return;
        updateConnection(conn.id, { model: $(this).val() });
        await syncSelectedConnectionRuntime(conn);
    });

    // ── Buttons ──

    // Add connection
    $('#apihub_btn_add').on('click', () => {
        $('#apihub_new_row').show();
        $('#apihub_new_input').val('').focus();
    });
    $('#apihub_new_ok').on('click', confirmNewConnection);
    $('#apihub_new_cancel').on('click', () => $('#apihub_new_row').hide());
    $('#apihub_new_input').on('keydown', (e) => {
        if (e.key === 'Enter') confirmNewConnection();
        if (e.key === 'Escape') $('#apihub_new_row').hide();
    });

    // Rename
    $('#apihub_btn_rename').on('click', () => {
        const conn = getSelectedConnection();
        if (!conn) return;
        $('#apihub_rename_row').show();
        $('#apihub_rename_input').val(conn.name).focus().select();
    });
    $('#apihub_rename_ok').on('click', confirmRename);
    $('#apihub_rename_cancel').on('click', () => $('#apihub_rename_row').hide());
    $('#apihub_rename_input').on('keydown', (e) => {
        if (e.key === 'Enter') confirmRename();
        if (e.key === 'Escape') $('#apihub_rename_row').hide();
    });

    // Duplicate
    $('#apihub_btn_duplicate').on('click', () => {
        const conn = getSelectedConnection();
        if (!conn) return;
        const dup = duplicateConnection(conn.id);
        if (dup) {
            renderUI();
            $('#apihub_connection_select').val(dup.id).trigger('change');
        }
    });

    // Save — re-activate current connection with latest edits
    $('#apihub_btn_save').on('click', async () => {
        const conn = getSelectedConnection();
        if (!conn) return;
        // Snapshot current preset/regex/post-processing state into connection
        const currentPresets = await readCurrentPresets();
        conn.preset = currentPresets.preset;
        conn.regexPreset = currentPresets.regexPreset;
        conn.promptPostProcessing = currentPresets.promptPostProcessing;
        await activateConnection(conn.id);
        toastr.success('连接配置已保存并激活');
    });

    // Delete
    $('#apihub_btn_delete').on('click', async () => {
        const conn = getSelectedConnection();
        if (!conn || getConnections().length <= 1) return;
        const confirmed = await callGenericPopup(`Delete connection "${conn.name}"?`, POPUP_TYPE.CONFIRM);
        if (!confirmed) return;
        deleteConnection(conn.id);
        renderUI();
    });

    // Fetch models
    $('#apihub_btn_fetch_models').on('click', fetchModels);

    // Default models — reset to hardcoded list
    $('#apihub_btn_default_models').on('click', async () => {
        const conn = getSelectedConnection();
        if (!conn) return;
        const defaults = DEFAULT_MODELS[conn.format] || [];
        const fmt = getFormatOption(conn.format);
        const newModel = (fmt && defaults.includes(fmt.defaultModel) ? fmt.defaultModel : defaults[0]) || '';
        updateConnection(conn.id, { availableModels: [...defaults], model: newModel });
        await syncSelectedConnectionRuntime(conn);
        if (defaults.length > 0) {
            toastr.success(`已重置为 ${defaults.length} 个默认模型`);
        } else {
            toastr.info('该格式无默认模型列表，已清空');
        }
    });

    // Add model manually
    $('#apihub_btn_add_model').on('click', () => {
        $('#apihub_add_model_row').show();
        $('#apihub_add_model_input').val('').focus();
    });
    $('#apihub_add_model_ok').on('click', confirmAddModel);
    $('#apihub_add_model_cancel').on('click', () => $('#apihub_add_model_row').hide());
    $('#apihub_add_model_input').on('keydown', (e) => {
        if (e.key === 'Enter') confirmAddModel();
        if (e.key === 'Escape') $('#apihub_add_model_row').hide();
    });

    // Delete selected model
    $('#apihub_btn_delete_model').on('click', async () => {
        const conn = getSelectedConnection();
        if (!conn) return;
        const selected = $('#apihub_model_select').val();
        if (!selected) return;
        conn.availableModels = conn.availableModels.filter(m => m !== selected);
        const newModel = conn.availableModels[0] || '';
        updateConnection(conn.id, { model: newModel });
        await syncSelectedConnectionRuntime(conn);
    });

    // Open native key manager
    $('#apihub_btn_manage_keys').on('click', async () => {
        const conn = getSelectedConnection();
        if (!conn) return;
        const secretKey = getSecretKeyForFormat(conn.format);
        startPendingSecretBinding(conn.id, secretKey);
        await bindConnectionToActiveSecret(conn.id, secretKey, {
            clearWhenMissing: false,
            activateIfActive: true,
        });
        openNativeKeyManager(conn.format);
    });

    // Import/Export
    $('#apihub_btn_export').on('click', exportConnections);
    $('#apihub_btn_import').on('click', importConnections);
    $('#apihub_btn_debug').on('click', exportDebug);

    // Reset all ApiHub data
    $('#apihub_btn_reset').on('click', async () => {
        const confirmed = await callGenericPopup(
            '清除所有 API Hub 数据（连接配置、激活状态），恢复为初始 3 个预设。\n\n不会影响 SillyTavern 原生配置。',
            POPUP_TYPE.CONFIRM,
        );
        if (!confirmed) return;
        extension_settings.apiHub = structuredClone(DEFAULT_SETTINGS);
        saveSettingsDebounced();
        await restoreState();
        toastr.success('API Hub 已重置');
    });

    // Migrate from native config
    $('#apihub_btn_migrate').on('click', async () => {
        const confirmed = await callGenericPopup(
            '从 SillyTavern 原生配置中检测并迁移已有的连接设置（Custom / Anthropic / Gemini）。\n\n已存在的相同配置不会重复导入。',
            POPUP_TYPE.CONFIRM,
        );
        if (!confirmed) return;
        await migrateFromNative();
    });

    // ── Request Parameter Exclusions ──

    // Collapsible toggle
    $('#apihub_params_toggle').on('click', () => {
        $('#apihub_params_panel').toggle();
        $('#apihub_params_toggle .apihub_collapse_icon').toggleClass('open');
    });

    // Exclude body checkboxes
    $('#apihub_exclude_body').on('change', 'input[type="checkbox"]', function () {
        const conn = getSelectedConnection();
        if (!conn) return;
        conn.excludeBody = conn.excludeBody || [];
        const key = $(this).val();
        if ($(this).is(':checked')) {
            if (!conn.excludeBody.includes(key)) conn.excludeBody.push(key);
        } else {
            conn.excludeBody = conn.excludeBody.filter(k => k !== key);
        }
        saveSettingsDebounced();
    });
}

// ── Inline action helpers ──────────────────────────────────────────

async function confirmNewConnection() {
    const name = $('#apihub_new_input').val()?.trim();
    if (!name) return;
    const conn = await createConnection(name);
    $('#apihub_new_row').hide();
    renderUI();
    $('#apihub_connection_select').val(conn.id).trigger('change');
}

function confirmRename() {
    const name = $('#apihub_rename_input').val()?.trim();
    const conn = getSelectedConnection();
    if (!name || !conn) return;
    updateConnection(conn.id, { name });
    $('#apihub_rename_row').hide();
    renderUI();
}

async function confirmAddModel() {
    const modelName = $('#apihub_add_model_input').val()?.trim();
    const conn = getSelectedConnection();
    if (!modelName || !conn) return;
    if (!conn.availableModels.includes(modelName)) {
        conn.availableModels.push(modelName);
    }
    updateConnection(conn.id, { model: modelName });
    $('#apihub_add_model_row').hide();
    await syncSelectedConnectionRuntime(conn);
}

// ── Initialization ─────────────────────────────────────────────────

async function restoreState() {
    const conns = getConnections();

    // Replace legacy single "Default" connection with 3 format-specific presets
    const isLegacy = conns.length === 1 && conns[0].name === 'Default';
    if (conns.length === 0 || isLegacy) {
        if (isLegacy) conns.splice(0, 1);
        createPresetConnection('示例 OpenAI Compatible', 'openai');
        createPresetConnection('示例 Anthropic', 'anthropic');
        createPresetConnection('示例 Google Gemini', 'gemini');
        saveSettingsDebounced();
    }

    // Cleanup legacy fields from old versions.
    for (const conn of conns) {
        conn.excludeBody = Array.isArray(conn.excludeBody) ? conn.excludeBody : [];
        delete conn.includeBody;
        delete conn.includeHeaders;
    }

    renderUI();

    const activeId = getActiveConnectionId();
    if (!activeId || !getConnection(activeId)) return;

    $('#apihub_connection_select').val(activeId);
    renderConnectionDetails();
    renderUrlPreview();
    renderCustomParams();
    await activateConnection(activeId);
}

jQuery(async () => {
    // Initialize settings
    if (!extension_settings.apiHub) {
        extension_settings.apiHub = structuredClone(DEFAULT_SETTINGS);
    }
    // Fill missing keys
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (extension_settings.apiHub[key] === undefined) {
            extension_settings.apiHub[key] = structuredClone(DEFAULT_SETTINGS[key]);
        }
    }

    // Render UI template
    const html = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    console.log('[ApiHub] Template loaded, length:', html?.length);

    // Inject into #openai_api at the top
    const container = document.getElementById('openai_api');
    console.log('[ApiHub] #openai_api found:', !!container);
    if (!container) {
        console.warn('[ApiHub] #openai_api container not found');
        return;
    }
    container.insertAdjacentHTML('afterbegin', html);
    console.log('[ApiHub] HTML injected, #apihub_container exists:', !!document.getElementById('apihub_container'));

    // Hide native Chat Completion Source UI
    hideNativeUI();

    // Bind events
    bindEvents();

    // Repair drifted native state before ST assembles the provider-specific request body.
    eventSource.on(event_types.GENERATION_STARTED, repairActiveConnectionBeforeGeneration);

    // Apply ApiHub exclusions right before ST sends chat-completion requests.
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, applyActiveConnectionExclusions);
    eventSource.makeLast(event_types.CHAT_COMPLETION_SETTINGS_READY, applyActiveConnectionExclusions);

    // Patch the native secret manager with bulk tools.
    initSecretManagerPatch();

    // Restore saved state
    await restoreState();

    // Native key manager actions can change the active secret outside ApiHub.
    [event_types.SECRET_WRITTEN, event_types.SECRET_ROTATED, event_types.SECRET_DELETED, event_types.SECRET_EDITED].forEach(eventName => {
        eventSource.on(eventName, async (key) => {
            clearSecretCachesForKey(key);
            refreshOpenSecretManagers(key);

            if (pendingSecretBinding && pendingSecretBinding.expiresAt < Date.now()) {
                pendingSecretBinding = null;
            }

            const shouldBindPending = pendingSecretBinding?.secretKey === key
                && [event_types.SECRET_WRITTEN, event_types.SECRET_ROTATED].includes(eventName);
            if (shouldBindPending) {
                await bindConnectionToActiveSecret(pendingSecretBinding.connectionId, key);
            }

            const selected = getSelectedConnection();
            if (!selected) return;
            if (getSecretKeyForFormat(selected.format) !== key) return;
            if (selected.id === getActiveConnectionId() && selected.secretId) {
                await activateConnection(selected.id);
                return;
            }
            renderConnectionDetails();
        });
    });

    console.log('[ApiHub] Extension loaded');
});
