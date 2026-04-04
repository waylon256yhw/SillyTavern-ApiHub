/**
 * SillyTavern-ApiHub — Unified API Connection Extension
 *
 * Replaces the native 24-source Chat Completion Source selector with a
 * protocol-centric UI (OpenAI Compatible / Anthropic / Gemini).
 */

import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { oai_settings, chat_completion_sources, model_list } from '../../../openai.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import { eventSource, event_types } from '../../../../script.js';
import { SECRET_KEYS, writeSecret } from '../../../secrets.js';
import { uuidv4 } from '../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { computeUrlPreview, normalizeUrl, FORMAT_OPTIONS, getFormatOption, maskApiKey } from './url-utils.js';

// ── Constants ──────────────────────────────────────────────────────

const MODULE_NAME = 'third-party/SillyTavern-ApiHub';

const DEFAULT_SETTINGS = {
    connections: [],
    activeConnectionId: null,
    keyVault: [], // { id, name, key }
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

function createConnection(name) {
    const fmt = FORMAT_OPTIONS[0]; // default: openai
    const conn = {
        id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: name || 'New Connection',
        format: fmt.value,
        endpoint: fmt.defaultEndpoint,
        apiKey: '',
        model: fmt.defaultModel,
        availableModels: [...fmt.defaultModels],
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

    // Ensure this connection is activated so source/URL/key are set
    await activateConnection(conn.id);

    updateConnection(conn.id, { status: 'testing', statusMessage: 'Fetching models...' });
    renderStatus(conn);

    // Trigger the native Connect button which calls getStatusOpen()
    $('#api_button_openai').trigger('click');

    // Wait for model_list to be reassigned (poll with timeout)
    // ST's getStatusOpen does `model_list = data.map(...)`, so the reference changes
    const startRef = model_list;
    let waited = 0;
    const interval = 200;
    const timeout = 15000;

    await new Promise((resolve) => {
        const check = () => {
            waited += interval;
            if (model_list !== startRef || waited >= timeout) {
                resolve();
                return;
            }
            setTimeout(check, interval);
        };
        setTimeout(check, interval);
    });

    // Store fetched models into connection
    if (model_list.length > 0) {
        const models = model_list.map(m => m.id || m.name || String(m));
        updateConnection(conn.id, {
            availableModels: models,
            status: 'connected',
            statusMessage: `${models.length} models found`,
        });
        // Auto-select first model if current model not in list
        if (!models.includes(conn.model) && models.length > 0) {
            updateConnection(conn.id, { model: models[0] });
        }
    } else {
        updateConnection(conn.id, {
            status: 'error',
            statusMessage: 'No models returned',
        });
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

// ── Key Vault ──────────────────────────────────────────────────────

function getKeyVault() {
    return getSettings().keyVault;
}

async function showKeyVaultPopup() {
    const vault = getKeyVault();

    let html = '<div class="apihub_vault_popup">';
    html += '<h4>Key Vault</h4>';
    html += '<p style="font-size:0.8em;opacity:0.6;">Keys are stored locally in SillyTavern settings.</p>';

    // Existing keys
    if (vault.length > 0) {
        html += '<div style="margin:8px 0;display:flex;flex-direction:column;gap:4px;">';
        for (const entry of vault) {
            html += `<div class="apihub_vault_entry" style="display:flex;align-items:center;gap:6px;">
                <span style="flex:1;font-size:0.9em;">${entry.name}</span>
                <span style="font-size:0.75em;opacity:0.5;font-family:monospace;">${maskApiKey(entry.key)}</span>
                <span class="apihub_vault_delete menu_button menu_button_icon" data-vault-id="${entry.id}" title="Delete">
                    <i class="fa-solid fa-trash-can"></i>
                </span>
            </div>`;
        }
        html += '</div>';
    }

    // Add new
    html += `<div style="display:flex;flex-direction:column;gap:4px;margin-top:8px;border-top:1px solid var(--SmartThemeBorderColor);padding-top:8px;">
        <input id="apihub_vault_new_name" type="text" class="text_pole" placeholder="Key name (e.g. OpenRouter)" />
        <div style="display:flex;gap:4px;">
            <input id="apihub_vault_new_key" type="password" class="text_pole" style="flex:1;font-family:monospace;" placeholder="sk-..." />
            <div id="apihub_vault_add_btn" class="menu_button">Save</div>
        </div>
    </div>`;
    html += '</div>';

    const dlg = $(html);

    // Wire delete buttons (event delegation for dynamically added entries)
    dlg.on('click', '.apihub_vault_delete', function () {
        const vid = $(this).data('vault-id');
        const idx = vault.findIndex(v => v.id === vid);
        if (idx !== -1) {
            vault.splice(idx, 1);
            saveSettingsDebounced();
            $(this).closest('.apihub_vault_entry').remove();
            renderVaultChips();
        }
    });

    // Wire add button
    dlg.find('#apihub_vault_add_btn').on('click', () => {
        const name = dlg.find('#apihub_vault_new_name').val()?.trim();
        const key = dlg.find('#apihub_vault_new_key').val()?.trim();
        if (!name || !key) return;
        vault.push({ id: uuidv4(), name, key });
        saveSettingsDebounced();
        renderVaultChips();
        // Re-render the entries list and clear inputs
        dlg.find('#apihub_vault_new_name').val('');
        dlg.find('#apihub_vault_new_key').val('');
        // Add the new entry to the visible list
        const entryHtml = `<div class="apihub_vault_entry" style="display:flex;align-items:center;gap:6px;">
            <span style="flex:1;font-size:0.9em;">${name}</span>
            <span style="font-size:0.75em;opacity:0.5;font-family:monospace;">${maskApiKey(key)}</span>
            <span class="apihub_vault_delete menu_button menu_button_icon" data-vault-id="${vault[vault.length - 1].id}" title="Delete">
                <i class="fa-solid fa-trash-can"></i>
            </span>
        </div>`;
        dlg.find('.apihub_vault_popup > div').first().append(entryHtml);
        toastr.success(`Key "${name}" saved to vault`);
    });

    await callGenericPopup(dlg, POPUP_TYPE.TEXT, '', { wide: false, large: false });
    renderVaultChips();
}

function renderVaultChips() {
    const vault = getKeyVault();
    const container = $('#apihub_vault_chips');
    if (vault.length === 0) {
        container.hide();
        return;
    }
    container.empty().show();
    const hint = $('<span class="apihub_hint" style="margin-right:4px;">Fill from vault:</span>');
    container.append(hint);
    for (const entry of vault) {
        const chip = $(`<span class="apihub_chip" data-vault-id="${entry.id}">${entry.name}</span>`);
        chip.on('click', () => {
            $('#apihub_apikey').val(entry.key).trigger('input');
        });
        container.append(chip);
    }
}

// ── Import / Export ────────────────────────────────────────────────

function exportConnections() {
    const data = getConnections().map(c => ({ ...c, apiKey: '' })); // strip keys
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `apihub-connections-${Date.now()}.json`;
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
            const data = JSON.parse(text);
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

// ── UI Rendering ───────────────────────────────────────────────────

function renderUI() {
    renderConnectionSelect();
    renderConnectionDetails();
    renderUrlPreview();
    renderVaultChips();
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

    // Format
    $('#apihub_format_select').val(conn.format);

    // Endpoint
    $('#apihub_endpoint').val(conn.endpoint);

    // API key
    $('#apihub_apikey').val(conn.apiKey);

    // Model select
    renderModelList(conn);

    // Active badge
    if (conn.id === activeId) {
        $('#apihub_active_badge').show();
        $('#apihub_inactive_hint').hide();
    } else {
        $('#apihub_active_badge').hide();
        const activeName = getActiveConnection()?.name || '—';
        $('#apihub_active_name').text(activeName);
        $('#apihub_inactive_hint').show();
    }

    // Status
    renderStatus(conn);
}

function renderModelList(conn) {
    conn = conn || getSelectedConnection();
    if (!conn) return;

    const select = $('#apihub_model_select');
    select.empty();

    if (conn.availableModels.length === 0) {
        select.append($('<option>', { value: '', text: 'No models — click Fetch', disabled: true }));
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
    $('#apihub_preview_models_method').text(preview.modelsMethod);
    $('#apihub_preview_models_url').text(preview.modelsUrl);
    $('#apihub_preview_auth').text(preview.authScheme);

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
    // Hide the native "Chat Completion Source" label and dropdown
    const sourceSelect = $('#chat_completion_source');
    sourceSelect.prevAll('h4').first().hide();
    sourceSelect.hide();

    // Hide native API connection forms for the three sources we manage.
    // These have data-source attributes and are toggled by toggleChatCompletionForms(),
    // so we need to re-hide them each time the source changes.
    const formsToHide = '#claude_form, #makersuite_form, #custom_form';

    // Hide the reverse proxy section (used by claude/makersuite)
    const reverseProxySection = '#openai_reverse_proxy, #openai_reverse_proxy_name, #ReverseProxyWarningMessage, #ReverseProxyWarningMessage2';

    // Hide custom source URL and model inputs
    const customInputs = '#custom_api_url_text, #custom_model_id';

    // Hide native "Additional Parameters" button
    const additionalParams = '#customize_additional_parameters';

    // Apply initial hide
    const allSelectors = `${formsToHide}, ${reverseProxySection}, ${customInputs}, ${additionalParams}`;
    $(allSelectors).closest('.range-block, form, div[data-source]').add($(additionalParams)).hide();

    // Re-apply after source changes (toggleChatCompletionForms re-shows data-source elements)
    $(document).on('change', '#chat_completion_source', () => {
        $(allSelectors).closest('.range-block, form, div[data-source]').add($(additionalParams)).hide();
    });
}

// ── Event Binding ──────────────────────────────────────────────────

function bindEvents() {
    // Connection selector
    $('#apihub_connection_select').on('change', () => {
        renderConnectionDetails();
        renderUrlPreview();
        renderCustomParams();
    });

    // Format change
    $('#apihub_format_select').on('change', function () {
        const conn = getSelectedConnection();
        if (!conn) return;
        const format = $(this).val();
        const fmt = getFormatOption(format);
        updateConnection(conn.id, {
            format,
            endpoint: fmt.defaultEndpoint,
            model: fmt.defaultModel,
            availableModels: [...fmt.defaultModels],
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

    // Activate
    $('#apihub_btn_activate').on('click', async () => {
        const conn = getSelectedConnection();
        if (!conn) return;
        await activateConnection(conn.id);
    });
    $('#apihub_btn_activate_inline').on('click', async () => {
        const conn = getSelectedConnection();
        if (!conn) return;
        await activateConnection(conn.id);
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

    // Key vault
    $('#apihub_btn_keyvault').on('click', showKeyVaultPopup);

    // Import/Export
    $('#apihub_btn_export').on('click', exportConnections);
    $('#apihub_btn_import').on('click', importConnections);

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

    // If no connections exist, create a default one
    if (conns.length === 0) {
        createConnection('Default');
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
