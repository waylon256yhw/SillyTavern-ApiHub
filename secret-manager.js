import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { copyText } from '../../../utils.js';

const PAGE_SIZE = 50;

/** Owns one manager session, including off-page selection and binding intent. */
export function createSecretManager(vault) {
    let current = null;

    async function open(key, { connectionId = null, name = key } = {}) {
        if (current) return;
        const root = $(`
            <div class="secretKeyManager apihub_secret_manager">
                <div class="secretKeyManagerHeader">
                    <div class="secretKeyManagerSubtitle">
                        <div class="secretKeyManagerInfo"><strong class="apihub_secret_name"></strong><code></code></div>
                        <button class="menu_button" type="button" data-action="add">新增密钥</button>
                    </div>
                </div>
                <input class="text_pole apihub_secret_search" type="search" placeholder="搜索标签或 ID" aria-label="搜索密钥标签或 ID" />
                <div class="apihub_secret_bulk_bar">
                    <div class="apihub_secret_bulk_group">
                        <button class="menu_button" type="button" data-action="select-page">选择本页</button>
                        <button class="menu_button" type="button" data-action="select-all">全选搜索结果</button>
                        <button class="menu_button" type="button" data-action="clear">清空选择</button>
                    </div>
                    <div class="apihub_secret_bulk_group">
                        <button class="menu_button" type="button" data-action="import">导入</button>
                        <button class="menu_button" type="button" data-action="export">导出所选</button>
                        <button class="menu_button" type="button" data-action="delete-selected">删除所选</button>
                    </div>
                    <div class="apihub_secret_bulk_count" aria-live="polite"></div>
                </div>
                <div class="apihub_secret_progress" role="status">
                    <span></span><button class="menu_button" type="button" data-action="cancel">停止</button>
                </div>
                <div class="secretKeyManagerList"></div>
                <div class="secretKeyManagerListEmpty">没有匹配的密钥</div>
                <div class="apihub_secret_pager">
                    <button class="menu_button" type="button" data-action="previous">上一页</button>
                    <span aria-live="polite"></span>
                    <button class="menu_button" type="button" data-action="next">下一页</button>
                </div>
            </div>
        `);
        const activeIndex = vault.entries(key).findIndex(entry => entry.active);
        const session = {
            key, connectionId, root, selection: new Set(), query: '',
            page: Math.max(0, Math.floor(activeIndex / PAGE_SIZE)),
            filtered: [], visible: [], busy: false, controller: null, searchTimer: null,
        };
        current = session;
        root.find('.apihub_secret_name').text(name);
        root.find('.secretKeyManagerInfo code').text(key);
        root.find('.apihub_secret_search').on('input', function () {
            clearTimeout(session.searchTimer);
            session.searchTimer = setTimeout(() => {
                session.query = String($(this).val()).trim().toLocaleLowerCase();
                session.page = 0;
                render(session);
            }, 120);
        });
        root.on('change', '.apihub_secret_bulk_checkbox', function () {
            const id = $(this).closest('[data-secret-id]').attr('data-secret-id');
            if (this.checked) session.selection.add(id);
            else session.selection.delete(id);
            updateSelection(session);
        });
        root.on('click', '[data-action]', function () {
            const action = $(this).attr('data-action');
            if (action === 'cancel') {
                session.controller?.abort();
                root.find('.apihub_secret_progress span').text('正在停止，等待当前请求及状态同步完成…');
                $(this).prop('disabled', true);
                return;
            }
            if (session.busy || $(this).prop('disabled')) return;
            const id = $(this).closest('[data-secret-id]').attr('data-secret-id');
            if (action === 'import') {
                chooseImport(session);
                return;
            }
            void run(session, () => perform(session, action, id));
        });

        try {
            render(session);
            await callGenericPopup(root, POPUP_TYPE.TEXT, '', {
                wide: true, large: true,
                onClosing: () => {
                    if (!session.busy) return true;
                    session.controller?.abort();
                    toastr.info('请等待当前操作和状态同步完成后关闭');
                    return false;
                },
                onClose: () => { if (current === session) current = null; },
            });
        } finally {
            clearTimeout(session.searchTimer);
            root.off();
            if (current === session) current = null;
        }
    }

    function render(session) {
        if (current !== session) return;
        const { root, key, selection, query } = session;
        const records = vault.entries(key);
        const validIds = new Set(records.map(entry => entry.id));
        for (const id of selection) if (!validIds.has(id)) selection.delete(id);
        session.filtered = query
            ? records.filter(entry => `${entry.label || ''}\n${entry.id}`.toLocaleLowerCase().includes(query))
            : records;
        const pages = Math.max(1, Math.ceil(session.filtered.length / PAGE_SIZE));
        session.page = Math.min(session.page, pages - 1);
        session.visible = session.filtered.slice(session.page * PAGE_SIZE, (session.page + 1) * PAGE_SIZE);
        const list = root.find('.secretKeyManagerList');
        const scrollTop = list.scrollTop();
        list.empty().append(session.visible.map(buildRow)).scrollTop(scrollTop);
        root.find('.secretKeyManagerListEmpty').toggle(session.visible.length === 0);
        root.find('.apihub_secret_pager span').text(`${session.page + 1} / ${pages} 页 · ${session.filtered.length} 条匹配 / 共 ${records.length} 条`);
        root.find('button, input').prop('disabled', session.busy);
        root.find('[data-action="previous"]').prop('disabled', session.busy || session.page === 0);
        root.find('[data-action="next"]').prop('disabled', session.busy || session.page === pages - 1);
        root.find('.secretKeyManagerItem.active [data-action="rotate"]').prop('disabled', true);
        updateSelection(session);
    }

    function buildRow(secret) {
        const row = $(`
            <div class="secretKeyManagerItem">
                <label class="apihub_secret_bulk_toggle"><input type="checkbox" class="apihub_secret_bulk_checkbox" aria-label="选择密钥" /></label>
                <div class="secretKeyManagerItemInfo">
                    <div class="secretKeyManagerItemHeader"><strong></strong><small></small></div>
                    <div class="secretKeyManagerItemSubtitle"><strong>ID: </strong><button class="secretKeyManagerItemId" type="button" data-action="copy-id" title="复制 ID"></button></div>
                </div>
                <div class="secretKeyManagerItemActions">
                    <div class="secretKeyManagerItemActionsRow">
                        <button class="menu_button" type="button" data-action="rotate" title="设为当前密钥"><i class="fa-fw fa-solid fa-check"></i></button>
                        <button class="menu_button" type="button" data-action="copy" title="复制明文"><i class="fa-fw fa-solid fa-copy"></i></button>
                    </div>
                    <div class="secretKeyManagerItemActionsRow">
                        <button class="menu_button" type="button" data-action="rename" title="重命名"><i class="fa-fw fa-solid fa-pen-to-square"></i></button>
                        <button class="menu_button" type="button" data-action="delete" title="删除"><i class="fa-fw fa-solid fa-trash"></i></button>
                    </div>
                </div>
            </div>
        `).attr('data-secret-id', secret.id).toggleClass('active', !!secret.active);
        row.find('.secretKeyManagerItemHeader strong').text(secret.label || '未命名密钥');
        // Display only a preview, including when native state exposes plaintext.
        row.find('.secretKeyManagerItemHeader small').text(secret.value ? `••••••${secret.value.slice(-3)}` : '（空密钥）');
        row.find('.secretKeyManagerItemId').text(secret.id);
        return row;
    }

    function updateSelection({ root, selection, busy }) {
        root.find('[data-secret-id]').each(function () {
            const checked = selection.has($(this).attr('data-secret-id'));
            $(this).toggleClass('apihub_secret_selected', checked).find('input').prop('checked', checked);
        });
        root.find('.apihub_secret_bulk_count').text(`${selection.size} 已选（包含其他页）`);
        root.find('[data-action="export"], [data-action="delete-selected"], [data-action="clear"]').prop('disabled', busy || selection.size === 0);
    }

    async function run(session, action) {
        session.busy = true;
        session.root.find('button, input').prop('disabled', true);
        try {
            await action();
        } catch (error) {
            toastr.error(error.message || '密钥操作失败');
        } finally {
            session.busy = false;
            session.controller = null;
            session.root.find('.apihub_secret_progress').hide();
            render(session);
        }
    }

    async function perform(session, action, id) {
        const { key, selection, root } = session;
        const entry = id ? vault.entries(key).find(item => item.id === id) : null;
        switch (action) {
            case 'previous': session.page--; root.find('.secretKeyManagerList').scrollTop(0); break;
            case 'next': session.page++; root.find('.secretKeyManagerList').scrollTop(0); break;
            case 'select-page': for (const record of session.visible) selection.add(record.id); break;
            case 'select-all': for (const record of session.filtered) selection.add(record.id); break;
            case 'clear': selection.clear(); break;
            case 'copy-id': await copyText(id); toastr.info('密钥 ID 已复制'); break;
            case 'copy': {
                const { value, status } = await vault.readValue(key, id);
                if (value === null) throw new Error(status === 403 ? '未允许读取密钥明文，请检查 allowKeysExposure 设置。' : '无法读取密钥，请刷新后重试。');
                await copyText(value);
                toastr.info('密钥值已复制');
                break;
            }
            case 'rotate': await vault.mutate(key, 'rotate', { id }); break;
            case 'rename': {
                const label = await callGenericPopup('输入新的密钥标签：', POPUP_TYPE.INPUT, entry?.label || '');
                if (typeof label === 'string' && label.trim()) await vault.mutate(key, 'rename', { id, label: label.trim() });
                break;
            }
            case 'add': {
                let label = '';
                const value = await callGenericPopup('输入密钥值（可留空）：', POPUP_TYPE.INPUT, '', {
                    customInputs: [{ id: 'apihub_new_secret_label', type: 'text', label: '标签（可选）' }],
                    onClose: popup => { label = String(popup.inputResults?.get('apihub_new_secret_label') || '').trim(); },
                });
                if (typeof value !== 'string') break;
                if (!value && !await callGenericPopup('确定新增一条空密钥？', POPUP_TYPE.CONFIRM)) break;
                await vault.mutate(key, 'write', { value, label: label || new Date().toLocaleString() });
                break;
            }
            case 'delete':
            case 'delete-selected': {
                const ids = action === 'delete' ? [id] : [...selection];
                const prompt = $('<div></div>').text(action === 'delete'
                    ? `确定删除密钥“${entry?.label || id}”？此操作不可撤销。`
                    : `确定删除选中的 ${ids.length} 个密钥（包含其他页）？此操作不可撤销。`);
                if (!await callGenericPopup(prompt, POPUP_TYPE.CONFIRM)) break;
                const result = await vault.deleteMany(key, ids, progressOptions(session, ids.length, '删除'));
                for (const deletedId of result.ids) selection.delete(deletedId);
                reportBatch(result, `已删除 ${result.completed} 个密钥`);
                break;
            }
            case 'export': {
                const secrets = await vault.exportEntries(key, [...selection]);
                const blob = new Blob([JSON.stringify({ key, exportedAt: new Date().toISOString(), secrets }, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `secrets-${key}-${Date.now()}.json`;
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                toastr.success(`已导出 ${secrets.length} 个密钥`);
                break;
            }
        }
    }

    function progressOptions(session, total, label) {
        session.controller = new AbortController();
        let lastPaint = 0;
        const progress = session.root.find('.apihub_secret_progress').show();
        progress.find('span').text(`${label}：0 / ${total}`);
        progress.find('button').prop('disabled', false);
        return {
            signal: session.controller.signal,
            onProgress: result => {
                if (session.controller.signal.aborted) return;
                const now = performance.now();
                if (result.completed === total || now - lastPaint > 50) {
                    progress.find('span').text(`${label}：${result.completed} / ${total}`);
                    lastPaint = now;
                }
            },
        };
    }

    function reportBatch(result, message) {
        if (result.syncError) {
            toastr.error(`${message}；状态同步失败，请刷新页面后确认。`);
        } else if (result.error) {
            toastr.error(`${message}；操作已停止：${result.error.message || '请求失败'}。`);
        } else if (result.cancelled) {
            toastr.info(`${message}；已停止，已完成的修改不会撤销。`);
        } else {
            toastr.success(message);
        }
    }

    function chooseImport(session) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = () => {
            const file = input.files?.[0];
            if (!file || current !== session || session.busy) return;
            void run(session, async () => {
                let raw;
                try {
                    raw = JSON.parse(await file.text());
                } catch {
                    throw new Error('导入失败：文件格式无效');
                }
                if (raw?.key && raw.key !== session.key) throw new Error(`该文件属于 ${raw.key}，当前密钥槽是 ${session.key}`);
                const records = (Array.isArray(raw) ? raw : raw?.secrets);
                if (!Array.isArray(records)) throw new Error('导入失败：文件中没有密钥条目');
                const valid = records.filter(record => typeof record?.value === 'string');
                if (!valid.length) throw new Error('导入失败：没有有效密钥条目');
                const result = await vault.importMany(session.key, valid, progressOptions(session, valid.length, '导入'));
                session.selection = new Set(result.ids);
                reportBatch(result, `已导入 ${result.imported} 个密钥，复用 ${result.reused} 个已有密钥`);
            });
        };
        input.click();
    }

    return {
        open,
        clearBinding() { if (current) current.connectionId = null; },
        get binding() { return current?.connectionId ? { connectionId: current.connectionId, secretKey: current.key } : null; },
        refresh(key) { if (current?.key === key && !current.busy) render(current); },
    };
}
