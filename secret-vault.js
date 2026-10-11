/**
 * Native-vault reads and mutations. The adapter supplies transport and the one
 * native-state reconciliation after a write (including partial batch failures).
 * No DOM or SillyTavern globals: tests exercise the same operations as the UI.
 */
export function createSecretVault(adapter) {
    let snapshot = null;
    let snapshotSource = null;

    function invalidate() {
        snapshot = null;
        snapshotSource = null;
    }

    function entries(key) {
        const values = adapter.getState()[key];
        return Array.isArray(values) ? values : [];
    }

    async function readableEntries(key, { fresh = false } = {}) {
        const source = adapter.getState();
        if (fresh || source !== snapshotSource || !snapshot) {
            // In supported ST versions /read includes plaintext only when
            // exposure is enabled. Never infer permission from a display value.
            invalidate();
            const allowed = await adapter.canRead();
            if (allowed !== true) {
                const message = allowed === false
                    ? '未允许读取密钥明文，请检查 allowKeysExposure 设置。'
                    : '无法确认密钥读取权限，请稍后重试。';
                throw Object.assign(new Error(message), { status: allowed === false ? 403 : null });
            }
            const data = await adapter.request('read');
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                throw new Error('密钥库返回了无效的读取结果');
            }
            snapshot = data;
            snapshotSource = source;
        }
        return Array.isArray(snapshot[key]) ? snapshot[key] : [];
    }

    async function readValue(key, id) {
        try {
            const records = await readableEntries(key);
            const record = records.find(entry => id ? entry.id === id : entry.active);
            if (!record || typeof record.value !== 'string') return { value: null, status: 404 };
            return { value: record.value, status: 200 };
        } catch (error) {
            return { value: null, status: error.status || null };
        }
    }

    async function findByValue(key, value, label) {
        try {
            return (await readableEntries(key)).find(entry => entry.value === value
                && (label === undefined || entry.label === label)) || null;
        } catch {
            return null;
        }
    }

    async function batch(key, work, { signal, onProgress = () => {} } = {}) {
        const result = { completed: 0, imported: 0, reused: 0, ids: [], cancelled: false, error: null, syncError: null };
        const changes = new Set();
        const write = async (action, payload) => {
            // A failed request may already have reached the server. Reconcile
            // even if the first write fails; do not abort an in-flight write.
            changes.add(action);
            const data = await adapter.request(action, { key, ...payload });
            if (action === 'write' && !data?.id) throw new Error('新增密钥未返回 ID');
            return data;
        };
        try {
            await work({ result, write, stopped: () => !!signal?.aborted, progress: () => onProgress(result) });
        } catch (error) {
            result.error = error;
        } finally {
            result.cancelled = !!signal?.aborted;
            if (changes.size) {
                invalidate();
                try {
                    await adapter.reconcile(key, changes);
                } catch (error) {
                    result.syncError = error;
                }
            }
        }
        return result;
    }

    async function mutate(key, action, payload) {
        let response;
        const result = await batch(key, async ({ write, result }) => {
            response = await write(action, payload);
            result.completed++;
        });
        if (result.syncError) throw new Error('密钥可能已修改，但同步失败，请刷新页面后确认。');
        if (result.error) throw result.error;
        return response;
    }

    function deleteMany(key, ids, options) {
        return batch(key, async ({ result, write, stopped, progress }) => {
            for (const id of ids) {
                if (stopped()) break;
                await write('delete', { id });
                result.ids.push(id);
                result.completed++;
                progress();
            }
        }, options);
    }

    async function importMany(key, records, options) {
        // Refuse to import blindly when existing values cannot be compared.
        const existing = await readableEntries(key, { fresh: true });
        const byValue = new Map();
        for (const entry of existing) {
            if (!byValue.has(entry.value)) byValue.set(entry.value, entry.id);
        }
        return batch(key, async ({ result, write, stopped, progress }) => {
            let activeId = '';
            for (const record of records) {
                if (stopped()) break;
                if (typeof record?.value !== 'string') continue;
                let id = byValue.get(record.value);
                if (id) {
                    result.reused++;
                } else {
                    const label = typeof record.label === 'string' ? record.label.trim() : '';
                    ({ id } = await write('write', { value: record.value, label: label || new Date().toLocaleString() }));
                    byValue.set(record.value, id);
                    result.imported++;
                }
                result.ids.push(id);
                if (record.active) activeId = id;
                result.completed++;
                progress();
                // An import containing only existing values has no network
                // awaits. Yield periodically so stopping remains possible.
                if (result.completed % 100 === 0) await new Promise(resolve => setTimeout(resolve, 0));
            }
            if (activeId && !stopped()) await write('rotate', { id: activeId });
        }, options);
    }

    async function exportEntries(key, ids) {
        const records = new Map((await readableEntries(key, { fresh: true })).map(entry => [entry.id, entry]));
        return ids.map(id => {
            const entry = records.get(id);
            if (!entry || typeof entry.value !== 'string') throw new Error('选中的密钥已变化，请刷新列表后重新选择。');
            return { id, label: entry.label || '', value: entry.value, active: !!entry.active };
        });
    }

    return { entries, invalidate, readValue, findByValue, exportEntries, mutate, deleteMany, importMany };
}
