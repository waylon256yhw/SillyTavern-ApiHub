/**
 * SillyTavern-ApiHub — Unified API Connection Extension
 *
 * Replaces the native 24-source Chat Completion Source selector with a
 * protocol-centric UI (OpenAI Compatible / Anthropic / Gemini).
 */

import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { oai_settings, chat_completion_sources, proxies } from '../../../openai.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import { SECRET_KEYS, writeSecret } from '../../../secrets.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommandScope } from '../../../slash-commands/SlashCommandScope.js';
import { SlashCommandAbortController } from '../../../slash-commands/SlashCommandAbortController.js';
import { SlashCommandDebugController } from '../../../slash-commands/SlashCommandDebugController.js';
import { computeUrlPreview, normalizeUrl, FORMAT_OPTIONS, getFormatOption } from './url-utils.js';

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
        model: '',
        availableModels: [],
        excludeBody: [],          // string[] — parameter names to exclude
        includeBody: [],          // { key, value }[] — custom body params
        includeHeaders: [],       // { key, value }[] — custom headers
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
        model: fmt.defaultModel,
        availableModels: [...fmt.defaultModels],
        excludeBody: [],
        includeBody: [],
        includeHeaders: [],
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

// ── YAML conversion for custom parameters ────────────────────────

/**
 * Convert key-value pairs array to YAML string.
 * Values are auto-typed: numbers stay numeric, booleans stay boolean, rest is string.
 */
function kvPairsToYaml(pairs) {
    if (!pairs || pairs.length === 0) return '';
    const lines = [];
    for (const { key, value } of pairs) {
        if (!key) continue;
        // Try to preserve types: number, boolean, null
        let v = value;
        if (v === 'true') v = true;
        else if (v === 'false') v = false;
        else if (v === 'null' || v === '') v = null;
        else if (!isNaN(v) && v.trim() !== '') v = Number(v);
        else v = JSON.stringify(v); // quote strings for YAML safety
        lines.push(`${key}: ${v}`);
    }
    return lines.join('\n');
}

/**
 * Convert exclude keys array to YAML string (list of single-key objects with null value).
 * Format: "key1:\nkey2:\n..."
 */
function excludeKeysToYaml(keys) {
    if (!keys || keys.length === 0) return '';
    return keys.map(k => `${k}:`).join('\n');
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

// ── Core: Activate Connection → sync to oai_settings ───────────────

async function activateConnection(id) {
    const conn = getConnection(id);
    if (!conn) return;

    getSettings().activeConnectionId = id;

    // Write API key to backend secret storage — only when key changes
    if (conn.apiKey) {
        const secretKey = FORMAT_TO_SECRET[conn.format];
        if (secretKey && conn.apiKey !== conn._lastWrittenKey) {
            await writeSecret(secretKey, conn.apiKey);
            conn._lastWrittenKey = conn.apiKey;
        }
    }

    // Apply preset FIRST (before connection fields) — preset may overwrite oai_settings
    // when bind_preset_to_connection is enabled. We reapply our fields after.
    if (conn.preset) await runSlashCommand('preset', conn.preset);

    // Set oai_settings fields based on format (AFTER preset, so we override any preset-bound values)
    const { normalized } = normalizeUrl(conn.endpoint, conn.format);

    if (conn.format === 'openai') {
        oai_settings.custom_url = normalized;
        oai_settings.custom_model = conn.model;
    } else if (conn.format === 'anthropic') {
        oai_settings.reverse_proxy = normalized;
        oai_settings.proxy_password = conn.apiKey;
        oai_settings.claude_model = conn.model;
    } else if (conn.format === 'gemini') {
        // Don't use normalizeUrl for gemini reverse_proxy — ST's makersuite backend
        // adds its own /{apiVersion}/ path, so we must pass the raw base URL
        oai_settings.reverse_proxy = conn.endpoint.replace(/\/+$/, '');
        oai_settings.proxy_password = conn.apiKey;
        oai_settings.google_model = conn.model;
    }

    // Trigger source switch — this calls toggleChatCompletionForms(), reconnectOpenAi(), getStatusOpen()
    const targetSource = FORMAT_TO_SOURCE[conn.format];
    $('#chat_completion_source').val(targetSource).trigger('change');

    // Re-apply model AFTER source switch (toggleChatCompletionForms may overwrite from native selects)
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

    // Write custom parameters as YAML strings
    oai_settings.custom_include_body = kvPairsToYaml(conn.includeBody);
    oai_settings.custom_exclude_body = excludeKeysToYaml(conn.excludeBody);
    oai_settings.custom_include_headers = kvPairsToYaml(conn.includeHeaders);

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
 * Sync the current connection's model to ST native settings and selects.
 * Called on model change/add/delete so Test Message works immediately.
 */
function syncModelToNative(conn) {
    if (!conn) return;
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
    saveSettingsDebounced();
}

// ── Model fetching ─────────────────────────────────────────────────

async function fetchModels() {
    const conn = getSelectedConnection();
    if (!conn) return;

    try {
        // Official endpoints use native ST flow; all others use CUSTOM source GET /v1/models
        const officialHosts = {
            openai: 'api.openai.com',
            anthropic: 'api.anthropic.com',
            gemini: 'googleapis.com',
        };
        const officialHost = officialHosts[conn.format];
        const isOfficial = officialHost && conn.endpoint.includes(officialHost);

        if (isOfficial) {
            await activateConnection(conn.id);
            await fetchModelsViaNativeConnect(conn);
            return;
        }

        // Non-official endpoints: direct backend call with CUSTOM source (GET /models + Bearer)
        const { normalized } = normalizeUrl(conn.endpoint, 'openai'); // always normalize as openai for /v1/models

        // Write API key to CUSTOM secret slot for this request
        if (conn.apiKey) {
            await writeSecret(SECRET_KEYS.CUSTOM, conn.apiKey);
        }

        const body = {
            chat_completion_source: chat_completion_sources.CUSTOM,
            custom_url: normalized,
            custom_include_headers: kvPairsToYaml(conn.includeHeaders),
        };

        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
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
        toastr.error(err.message || '拉取失败');
    }

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
    const secretKey = FORMAT_TO_SECRET[format];
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
        delete clean._lastWrittenKey; // runtime-only, don't persist
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
                c.endpoint = c.endpoint || '';
                c.model = c.model || '';
                c.availableModels = Array.isArray(c.availableModels) ? c.availableModels : [];
                c.excludeBody = Array.isArray(c.excludeBody) ? c.excludeBody : [];
                c.includeBody = Array.isArray(c.includeBody) ? c.includeBody : [];
                c.includeHeaders = Array.isArray(c.includeHeaders) ? c.includeHeaders : [];
                c.preset = c.preset || '';
                c.regexPreset = c.regexPreset || '';
                c.promptPostProcessing = c.promptPostProcessing || '';
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
    // Primary dedup: format+endpoint for CM profiles (same endpoint = same connection, model can differ)
    const cmKeys = new Set(getConnections().map(c => `${c.format}|${c.endpoint}`));
    // Secondary dedup: endpoint-only for proxy presets (avoid duplicating CM results)
    const endpointSet = new Set(getConnections().map(c => c.endpoint));

    function isCmDuplicate(format, endpoint) {
        return cmKeys.has(`${format}|${endpoint}`);
    }

    function isEndpointDuplicate(endpoint) {
        return endpointSet.has(endpoint);
    }

    function makeConn(name, format, endpoint, apiKey, model) {
        return {
            id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name,
            format,
            endpoint,
            apiKey: apiKey || '',
            model: model || '',
            availableModels: model ? [model] : [],
            excludeBody: [],
            includeBody: [],
            includeHeaders: [],
            status: 'idle',
            statusMessage: '',
        };
    }

    function addConn(conn) {
        getConnections().push(conn);
        cmKeys.add(`${conn.format}|${conn.endpoint}`);
        endpointSet.add(conn.endpoint);
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

            if (isCmDuplicate(format, endpoint)) continue;

            // Get API key from proxy password (findSecret requires allowKeysExposure)
            let apiKey = '';
            if (profile.proxy) {
                const proxyPreset = proxies.find(p => p.name === profile.proxy);
                if (proxyPreset && proxyPreset.password) {
                    apiKey = proxyPreset.password;
                }
            }

            const conn = makeConn(
                profile.name || `${getFormatOption(format).label} (migrated)`,
                format,
                endpoint,
                apiKey,
                profile.model || '',
            );

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
        if (isEndpointDuplicate(url)) continue;
        addConn(makeConn(proxy.name, 'openai', url, proxy.password, ''));
    }

    if (migrated.length > 0) {
        saveSettingsDebounced();
        renderUI();
        toastr.success(`已迁移 ${migrated.length} 个连接配置：${migrated.map(c => c.name).join('、')}`);
    } else {
        toastr.info('未检测到可迁移的原生连接配置');
    }

    return migrated;
}

/**
 * Parse YAML-style "key:\nkey2:\n" into array of key names.
 */
function parseYamlKeys(yamlStr) {
    if (!yamlStr) return [];
    return yamlStr.split('\n')
        .map(line => line.replace(/:.*$/, '').trim())
        .filter(Boolean);
}

/**
 * Parse YAML-style "key: value\nkey2: value2\n" into [{key, value}].
 */
function parseYamlKvPairs(yamlStr) {
    if (!yamlStr) return [];
    const pairs = [];
    for (const line of yamlStr.split('\n')) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key) pairs.push({ key, value });
    }
    return pairs;
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
    $('#apihub_apikey').val(conn.apiKey).attr('placeholder', conn._lastWrittenKey ? '密钥已保存' : 'sk-...');

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

// ── Custom Parameters Rendering ───────────────────────────────────

function renderCustomParams(conn) {
    conn = conn || getSelectedConnection();
    if (!conn) return;

    // Ensure arrays exist (migration for old connections)
    conn.excludeBody = conn.excludeBody || [];
    conn.includeBody = conn.includeBody || [];
    conn.includeHeaders = conn.includeHeaders || [];

    renderExcludeBody(conn);
    renderKvList($('#apihub_include_body'), conn.includeBody, 'body');
    renderKvList($('#apihub_include_headers'), conn.includeHeaders, 'header');
}

function renderExcludeBody(conn) {
    $('#apihub_exclude_body input[type="checkbox"]').each(function () {
        $(this).prop('checked', conn.excludeBody.includes($(this).val()));
    });
}

function renderKvList(container, pairs, type) {
    container.empty();
    for (let i = 0; i < pairs.length; i++) {
        const row = buildKvRow(pairs[i].key, pairs[i].value, type, i);
        container.append(row);
    }
}

function buildKvRow(key, value, type, index) {
    const row = $('<div class="apihub_kv_row"></div>');
    const keyInput = $(`<input type="text" class="text_pole apihub_kv_key" placeholder="key" value="${escapeHtml(key || '')}" data-type="${type}" data-index="${index}" />`);
    const valInput = $(`<input type="text" class="text_pole apihub_kv_value" placeholder="value" value="${escapeHtml(value || '')}" data-type="${type}" data-index="${index}" />`);
    const delBtn = $(`<div class="menu_button menu_button_icon apihub_kv_delete" data-type="${type}" data-index="${index}" title="Remove"><i class="fa-solid fa-xmark"></i></div>`);
    row.append(keyInput, valInput, delBtn);
    return row;
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Hide native UI elements ────────────────────────────────────────

let nativeUIVisible = false;

function applyNativeUIVisibility() {
    const sourceSelect = $('#chat_completion_source');
    const sourceForms = '#openai_form, #claude_form, #makersuite_form, #custom_form';

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
        updateConnection(conn.id, {
            format,
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
        const conn = getSelectedConnection();
        if (!conn) return;
        updateConnection(conn.id, { apiKey: $(this).val() });
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

    // Model change → activate immediately
    $('#apihub_model_select').on('change', async function () {
        const conn = getSelectedConnection();
        if (!conn) return;
        updateConnection(conn.id, { model: $(this).val() });
        syncModelToNative(conn);
        renderUrlPreview();
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
    $('#apihub_btn_delete_model').on('click', () => {
        const conn = getSelectedConnection();
        if (!conn) return;
        const selected = $('#apihub_model_select').val();
        if (!selected) return;
        conn.availableModels = conn.availableModels.filter(m => m !== selected);
        const newModel = conn.availableModels[0] || '';
        updateConnection(conn.id, { model: newModel });
        syncModelToNative(conn);
        renderModelList(conn);
        renderUrlPreview();
    });

    // Open native key manager
    $('#apihub_btn_manage_keys').on('click', () => {
        const conn = getSelectedConnection();
        if (!conn) return;
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
        restoreState();
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

    // ── Custom Parameters ──

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

    // Add body param
    $('#apihub_btn_add_param').on('click', () => {
        const conn = getSelectedConnection();
        if (!conn) return;
        conn.includeBody = conn.includeBody || [];
        conn.includeBody.push({ key: '', value: '' });
        saveSettingsDebounced();
        renderKvList($('#apihub_include_body'), conn.includeBody, 'body');
    });

    // Add header
    $('#apihub_btn_add_header').on('click', () => {
        const conn = getSelectedConnection();
        if (!conn) return;
        conn.includeHeaders = conn.includeHeaders || [];
        conn.includeHeaders.push({ key: '', value: '' });
        saveSettingsDebounced();
        renderKvList($('#apihub_include_headers'), conn.includeHeaders, 'header');
    });

    // KV input changes (event delegation)
    $(document).on('input', '.apihub_kv_key, .apihub_kv_value', function () {
        const conn = getSelectedConnection();
        if (!conn) return;
        const type = $(this).data('type');
        const index = $(this).data('index');
        const arr = type === 'body' ? conn.includeBody : conn.includeHeaders;
        if (!arr || !arr[index]) return;
        if ($(this).hasClass('apihub_kv_key')) {
            arr[index].key = $(this).val();
        } else {
            arr[index].value = $(this).val();
        }
        saveSettingsDebounced();
    });

    // KV delete (event delegation)
    $(document).on('click', '.apihub_kv_delete', function () {
        const conn = getSelectedConnection();
        if (!conn) return;
        const type = $(this).data('type');
        const index = $(this).data('index');
        const arr = type === 'body' ? conn.includeBody : conn.includeHeaders;
        if (!arr) return;
        arr.splice(index, 1);
        saveSettingsDebounced();
        const container = type === 'body' ? $('#apihub_include_body') : $('#apihub_include_headers');
        renderKvList(container, arr, type);
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

function confirmAddModel() {
    const modelName = $('#apihub_add_model_input').val()?.trim();
    const conn = getSelectedConnection();
    if (!modelName || !conn) return;
    if (!conn.availableModels.includes(modelName)) {
        conn.availableModels.push(modelName);
    }
    updateConnection(conn.id, { model: modelName });
    syncModelToNative(conn);
    $('#apihub_add_model_row').hide();
    renderModelList(conn);
    renderUrlPreview();
}

// ── Initialization ─────────────────────────────────────────────────

function restoreState() {
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

    renderUI();
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

    // Restore saved state
    restoreState();

    console.log('[ApiHub] Extension loaded');
});
