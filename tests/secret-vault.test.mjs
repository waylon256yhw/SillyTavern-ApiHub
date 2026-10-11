import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecretVault } from '../secret-vault.js';

const key = 'api_key_custom';
const entry = (id, value = `value-${id}`, active = false) => ({ id, value, label: `label-${id}`, active });

function fixture(records, { allowed = true, failId, failSync = false } = {}) {
    let database = structuredClone(records);
    let state = { [key]: structuredClone(database) };
    const requests = [];
    const syncs = [];
    let nextId = 0;
    const vault = createSecretVault({
        getState: () => state,
        canRead: async () => allowed,
        async request(action, body) {
            requests.push({ action, body });
            if (action === 'read') return { [key]: structuredClone(database) };
            if (failId !== undefined && body?.id === failId) throw new Error('test write failure');
            if (action === 'delete') database = database.filter(item => item.id !== body.id);
            if (action === 'write') {
                database.forEach(item => { item.active = false; });
                const record = { id: `new-${++nextId}`, value: body.value, label: body.label, active: true };
                database.push(record);
                return { id: record.id };
            }
            if (action === 'rotate') database.forEach(item => { item.active = item.id === body.id; });
            if (action === 'rename') database.find(item => item.id === body.id).label = body.label;
            return null;
        },
        async reconcile(slot, changes) {
            syncs.push({ slot, changes: [...changes] });
            if (failSync) throw new Error('test sync failure');
            state = { [key]: structuredClone(database) };
        },
    });
    return {
        vault, requests, syncs,
        nativeChange(records) { database = structuredClone(records); state = { [key]: structuredClone(records) }; },
    };
}

test('10,000-entry export includes off-page and non-active IDs in one read', async () => {
    const { vault, requests } = fixture(Array.from({ length: 10000 }, (_, i) => entry(String(i), `synthetic-${i}`, i === 0)));
    const result = await vault.exportEntries(key, ['0', '9999', '51']);
    assert.deepEqual(result.map(item => item.value), ['synthetic-0', 'synthetic-9999', 'synthetic-51']);
    assert.equal(result[1].active, false);
    assert.deepEqual(requests.map(request => request.action), ['read']);
});

test('permission denial never treats display text as plaintext or imports blindly', async () => {
    const { vault, requests } = fixture([entry('masked', '*******123')], { allowed: false });
    assert.equal(vault.entries(key).length, 1);
    assert.deepEqual(await vault.readValue(key, 'masked'), { value: null, status: 403 });
    await assert.rejects(vault.exportEntries(key, ['masked']), { status: 403 });
    await assert.rejects(vault.importMany(key, [{ value: 'new' }]), { status: 403 });
    assert.equal(requests.length, 0);
});

test('value access reuses a snapshot and invalidates on native-state replacement', async () => {
    const { vault, requests, nativeChange } = fixture([entry('a', '', true), entry('b', 'same')]);
    assert.deepEqual(await vault.readValue(key), { value: '', status: 200 });
    assert.equal((await vault.findByValue(key, 'same')).id, 'b');
    assert.equal((await vault.readValue(key, 'b')).value, 'same');
    assert.equal(requests.length, 1);
    nativeChange([entry('a', 'changed', true)]);
    assert.equal((await vault.readValue(key)).value, 'changed');
    assert.deepEqual(await vault.readValue(key, 'b'), { value: null, status: 404 });
    assert.equal(requests.length, 2);
});

test('bulk delete reconciles once, not after every record', async () => {
    const { vault, requests, syncs } = fixture(Array.from({ length: 100 }, (_, i) => entry(String(i))));
    const result = await vault.deleteMany(key, Array.from({ length: 100 }, (_, i) => String(i)));
    assert.equal(result.completed, 100);
    assert.equal(result.error, null);
    assert.equal(syncs.length, 1);
    assert.equal(requests.length, 100);
    assert.equal(vault.entries(key).length, 0);
});

test('partial failure stops and reconciles completed work without claiming full success', async () => {
    const { vault, syncs } = fixture([entry('a'), entry('b'), entry('c')], { failId: 'b' });
    const result = await vault.deleteMany(key, ['a', 'b', 'c']);
    assert.equal(result.completed, 1);
    assert.deepEqual(result.ids, ['a']);
    assert.match(result.error.message, /write failure/);
    assert.equal(syncs.length, 1);
    assert.deepEqual(vault.entries(key).map(item => item.id), ['b', 'c']);
});

test('cancellation keeps acknowledged writes and reconciles before returning', async () => {
    const { vault, syncs } = fixture([entry('a'), entry('b')]);
    const controller = new AbortController();
    const result = await vault.deleteMany(key, ['a', 'b'], {
        signal: controller.signal, onProgress: () => controller.abort(),
    });
    assert.equal(result.cancelled, true);
    assert.equal(result.completed, 1);
    assert.equal(syncs.length, 1);
    assert.deepEqual(vault.entries(key).map(item => item.id), ['b']);
});

test('import deduplicates existing and repeated values, preserves empty values and requested active ID', async () => {
    const { vault, requests, syncs } = fixture([entry('empty', ''), entry('old', 'existing', true)]);
    const result = await vault.importMany(key, [
        { value: '', active: true }, { value: 'new', label: 'new label' },
        { value: 'new' }, { value: 'existing' },
    ]);
    assert.equal(result.error, null);
    assert.equal(result.imported, 1);
    assert.equal(result.reused, 3);
    assert.equal(vault.entries(key).find(item => item.active).id, 'empty');
    assert.deepEqual(requests.map(request => request.action), ['read', 'write', 'rotate']);
    assert.equal(syncs.length, 1);
});

test('sync failure is reported separately from completed writes', async () => {
    const { vault } = fixture([entry('a')], { failSync: true });
    const result = await vault.deleteMany(key, ['a']);
    assert.equal(result.completed, 1);
    assert.equal(result.error, null);
    assert.match(result.syncError.message, /sync failure/);
    await assert.rejects(vault.mutate(key, 'write', { value: 'new' }), /同步失败/);
});
