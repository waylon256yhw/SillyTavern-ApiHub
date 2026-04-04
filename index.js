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

function createConnection(name, format) {
    const fmt = getFormatOption(format) || FORMAT_OPTIONS[0];
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
    // Reset status when core fields change
    if ('endpoint' in partial || 'apiKey' in partial || 'model' in partial || 'format' in partial) {
        partial.status = 'idle';
        partial.statusMessage = '';
    }
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

// ── Core: Activate Connection → sync to oai_settings ───────────────

async function activateConnection(id) {
    const conn = getConnection(id);
    if (!conn) return;

    getSettings().activeConnectionId = id;

    // Write API key to backend secret storage
    if (conn.apiKey) {
        const secretKey = FORMAT_TO_SECRET[conn.format];
        if (secretKey) {
            await writeSecret(secretKey, conn.apiKey);
        }
    }

    // Set oai_settings fields based on format
    const { normalized } = normalizeUrl(conn.endpoint, conn.format);

    if (conn.format === 'openai') {
        oai_settings.custom_url = normalized;
        oai_settings.custom_model = conn.model;
    } else if (conn.format === 'anthropic') {
        oai_settings.reverse_proxy = normalized;
        oai_settings.proxy_password = conn.apiKey;
        oai_settings.claude_model = conn.model;
    } else if (conn.format === 'gemini') {
        oai_settings.reverse_proxy = normalized;
        oai_settings.proxy_password = conn.apiKey;
        oai_settings.google_model = conn.model;
    }

    // Trigger source switch — this calls toggleChatCompletionForms(), reconnectOpenAi(), getStatusOpen()
    const targetSource = FORMAT_TO_SOURCE[conn.format];
    $('#chat_completion_source').val(targetSource).trigger('change');

    // Write custom parameters as YAML strings
    oai_settings.custom_include_body = kvPairsToYaml(conn.includeBody);
    oai_settings.custom_exclude_body = excludeKeysToYaml(conn.excludeBody);
    oai_settings.custom_include_headers = kvPairsToYaml(conn.includeHeaders);

    saveSettingsDebounced();
    renderUI();
}

// ── Model fetching ─────────────────────────────────────────────────

async function fetchModels() {
    const conn = getSelectedConnection();
    if (!conn) return;

    updateConnection(conn.id, { status: 'testing', statusMessage: 'Fetching models...' });
    renderStatus(conn);

    try {
        // Official endpoints use native ST flow; all others use CUSTOM source GET /v1/models
        const officialHosts = {
            openai: 'api.openai.com',
            anthropic: 'api.anthropic.com',
            gemini: 'googleapis.com',
        };
        const isOfficial = conn.endpoint.includes(officialHosts[conn.format] || '');

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
                    availableModels: models,
                    status: 'connected',
                    statusMessage: `${models.length} models found`,
                });
                if (!models.includes(conn.model)) {
                    updateConnection(conn.id, { model: models[0] });
                }
            } else {
                updateConnection(conn.id, { status: 'error', statusMessage: 'No models returned' });
            }
        } else {
            const errText = await response.text().catch(() => '');
            updateConnection(conn.id, { status: 'error', statusMessage: `Fetch failed: ${response.status} ${errText.slice(0, 100)}` });
        }
    } catch (err) {
        updateConnection(conn.id, { status: 'error', statusMessage: err.message || 'Fetch failed' });
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
            availableModels: googleModels,
            status: 'connected',
            statusMessage: `${googleModels.length} models found`,
        });
        if (!googleModels.includes(conn.model)) {
            updateConnection(conn.id, { model: googleModels[0] });
        }
    } else {
        updateConnection(conn.id, { status: 'error', statusMessage: 'No models returned' });
    }

    renderUI();
}
    } catch (err) {
        updateConnection(conn.id, { status: 'error', statusMessage: err.message || 'Fetch failed' });
    }

    renderUI();
}

// ── Connection test ────────────────────────────────────────────────

async function testConnection() {
    const conn = getSelectedConnection();
    if (!conn) return;

    // Ensure this connection is activated so source/URL/key are set
    await activateConnection(conn.id);

    // Trigger the native test button — it sends a quiet "Hi" request
    // and shows toastr success/error banners
    $('#test_api_button').trigger('click');
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
    const data = {
        apiHub: {
            connections: getConnections().map(c => ({ ...c, apiKey: c.apiKey ? '***' : '' })),
            activeConnectionId: getActiveConnectionId(),
        },
        // Debug: include native config for troubleshooting
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
                // Redact secret values but keep structure
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
            // Support both formats: array (legacy) or {apiHub: {connections: [...]}} (new)
            const data = Array.isArray(raw) ? raw : (raw?.apiHub?.connections || []);
            if (!Array.isArray(data) || data.length === 0) {
                toastr.warning('Import failed: file contains no connections');
                return;
            }
            const validFormats = FORMAT_OPTIONS.map(f => f.value);
            let imported = 0;
            for (const c of data) {
                // Validate required fields
                if (!c.name || !c.format || !validFormats.includes(c.format)) {
                    continue;
                }
                c.id = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                c.status = 'idle';
                c.statusMessage = '';
                c.apiKey = c.apiKey || '';
                c.endpoint = c.endpoint || getFormatOption(c.format).defaultEndpoint;
                c.model = c.model || getFormatOption(c.format).defaultModel;
                c.availableModels = Array.isArray(c.availableModels) ? c.availableModels : [...getFormatOption(c.format).defaultModels];
                c.excludeBody = Array.isArray(c.excludeBody) ? c.excludeBody : [];
                c.includeBody = Array.isArray(c.includeBody) ? c.includeBody : [];
                c.includeHeaders = Array.isArray(c.includeHeaders) ? c.includeHeaders : [];
                getConnections().push(c);
                imported++;
            }
            if (imported === 0) {
                toastr.warning('Import failed: no valid connections found');
                return;
            }
            toastr.success(`Imported ${imported} connection(s)`);
            saveSettingsDebounced();
            renderUI();
        } catch {
            toastr.error('Import failed: invalid file');
        }
    };
    input.click();
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
    // Primary dedup: format+endpoint+model for CM profiles (preserves same-endpoint different-model configs)
    const cmKeys = new Set(getConnections().map(c => `${c.format}|${c.endpoint}|${c.model}`));
    // Secondary dedup: endpoint-only for active config & proxy presets (avoid duplicating CM results)
    const endpointSet = new Set(getConnections().map(c => c.endpoint));

    function isCmDuplicate(format, endpoint, model) {
        return cmKeys.has(`${format}|${endpoint}|${model || ''}`);
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
        cmKeys.add(`${conn.format}|${conn.endpoint}|${conn.model}`);
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

            if (isCmDuplicate(format, endpoint, profile.model)) continue;

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

            addConn(conn);
        }
    }

    // Helper: extract host from URL for fuzzy endpoint comparison
    function getUrlHost(url) {
        try { return new URL(url).host; } catch { return url; }
    }

    // 2. Migrate active config if not already covered by profiles
    const activeSource = oai_settings.chat_completion_source;
    const activeFormat = SOURCE_TO_FORMAT[activeSource];
    if (activeFormat) {
        let endpoint;
        if (activeFormat === 'openai') {
            endpoint = (oai_settings.custom_url || '').trim();
        } else {
            endpoint = (oai_settings.reverse_proxy || '').trim() || getFormatOption(activeFormat).defaultEndpoint;
        }

        // Use host-based dedup: /v1 vs /v1beta on same host = same server
        const activeHost = getUrlHost(endpoint);
        const hostAlreadyExists = [...endpointSet].some(ep => getUrlHost(ep) === activeHost);

        if (endpoint && !hostAlreadyExists) {
            // Get API key from proxy_password (can't use findSecret without allowKeysExposure)
            let apiKey = '';
            if (activeFormat !== 'openai' && oai_settings.proxy_password) {
                apiKey = oai_settings.proxy_password;
            }

            const modelField = { openai: 'custom_model', anthropic: 'claude_model', gemini: 'google_model' }[activeFormat];
            const conn = makeConn(
                `${getFormatOption(activeFormat).label} (active)`,
                activeFormat,
                endpoint,
                apiKey,
                oai_settings[modelField] || '',
            );

            // Migrate custom params for openai
            if (activeFormat === 'openai') {
                conn.excludeBody = parseYamlKeys(oai_settings.custom_exclude_body);
                conn.includeBody = parseYamlKvPairs(oai_settings.custom_include_body);
                conn.includeHeaders = parseYamlKvPairs(oai_settings.custom_include_headers);
            }

            addConn(conn);
        }
    }

    // 3. Migrate proxy presets NOT already referenced by CM profiles
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
    $('#apihub_apikey').val(conn.apiKey);

    // Model select
    renderModelList(conn);

    // Active badge — always show since switch = activate
    $('#apihub_active_badge').toggle(conn.id === activeId);

    // Status
    renderStatus(conn);
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
        // Model not in list but set — add it
        select.prepend($('<option>', { value: conn.model, text: conn.model }));
        select.val(conn.model);
    }
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

    $('#apihub_preview_chat_method').text(preview.chatMethod);
    $('#apihub_preview_chat_url').text(preview.chatUrl);

    if (preview.literal) {
        $('#apihub_preview_literal').show();
    } else {
        $('#apihub_preview_literal').hide();
    }

    $('#apihub_url_preview').show();
}

function renderStatus(conn) {
    conn = conn || getSelectedConnection();
    if (!conn || conn.status === 'idle') {
        $('#apihub_status_section').hide();
        return;
    }

    const dot = $('#apihub_status_dot');
    const text = $('#apihub_status_text');

    dot.removeClass('connected error testing').addClass(conn.status);
    text.removeClass('connected error testing').addClass(conn.status);
    text.text(conn.statusMessage || conn.status);
    $('#apihub_status_section').show();
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

function hideNativeUI() {
    // Hide the source selector (we replace it with format + connection selector)
    const sourceSelect = $('#chat_completion_source');
    sourceSelect.prevAll('h4').first().hide();
    sourceSelect.hide();

    // Hide the Reverse Proxy inline-drawer (we manage endpoints)
    $('#openai_reverse_proxy').closest('.inline-drawer').hide();
    $('#ReverseProxyWarningMessage').hide();

    // Hide all native source forms (API key + model — we manage both)
    // They use data-source attributes and get re-shown by toggleChatCompletionForms
    const sourceForms = '#openai_form, #claude_form, #makersuite_form, #custom_form';
    $(sourceForms).hide();

    // Hide Connection Manager UI at top of #rm_api_block
    $('#connection_profiles').closest('.wide100p').hide();

    // Re-apply after source changes (toggleChatCompletionForms re-shows data-source elements)
    $(document).on('change', '#chat_completion_source', () => {
        sourceSelect.prevAll('h4').first().hide();
        sourceSelect.hide();
        $('#openai_reverse_proxy').closest('.inline-drawer').hide();
        $('#ReverseProxyWarningMessage').hide();
        $(sourceForms).hide();
    });
}

// ── Event Binding ──────────────────────────────────────────────────

function bindEvents() {
    // Connection selector — switch = activate
    $('#apihub_connection_select').on('change', async () => {
        const conn = getSelectedConnection();
        if (!conn) return;
        renderConnectionDetails();
        renderUrlPreview();
        renderCustomParams();
        await activateConnection(conn.id);
    });

    // Format change
    $('#apihub_format_select').on('change', function () {
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
    });

    // Endpoint input → live preview
    $('#apihub_endpoint').on('input', function () {
        const conn = getSelectedConnection();
        if (!conn) return;
        updateConnection(conn.id, { endpoint: $(this).val() });
        renderUrlPreview();
    });

    // API key input
    $('#apihub_apikey').on('input', function () {
        const conn = getSelectedConnection();
        if (!conn) return;
        updateConnection(conn.id, { apiKey: $(this).val() });
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

    // Model change
    $('#apihub_model_select').on('change', function () {
        const conn = getSelectedConnection();
        if (!conn) return;
        updateConnection(conn.id, { model: $(this).val() });
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

    // Test connection
    $('#apihub_btn_test').on('click', testConnection);

    // Open native key manager
    $('#apihub_btn_manage_keys').on('click', () => {
        const conn = getSelectedConnection();
        if (!conn) return;
        openNativeKeyManager(conn.format);
    });

    // Import/Export
    $('#apihub_btn_export').on('click', exportConnections);
    $('#apihub_btn_import').on('click', importConnections);

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

function confirmNewConnection() {
    const name = $('#apihub_new_input').val()?.trim();
    if (!name) return;
    const conn = createConnection(name);
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

    // Inject into #openai_api at the top
    const container = document.getElementById('openai_api');
    if (!container) {
        console.warn('[ApiHub] #openai_api container not found');
        return;
    }
    container.insertAdjacentHTML('afterbegin', html);

    // Hide native Chat Completion Source UI
    hideNativeUI();

    // Bind events
    bindEvents();

    // Restore saved state
    restoreState();

    console.log('[ApiHub] Extension loaded');
});
