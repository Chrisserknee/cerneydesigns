'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, MAX_RECORD_BYTES } = require('./storage');

function memoryBucket() {
    const files = new Map();
    let generation = 0;
    const error = (code) => Object.assign(new Error('Storage operation failed.'), { code });
    return {
        files,
        beforeDownload: null,
        file(name, options = {}) {
            const bucket = this;
            return {
                name,
                async getMetadata() {
                    const record = files.get(name);
                    if (!record) throw error(404);
                    return [{ generation: String(record.generation), size: String(Buffer.byteLength(record.data)), ...record.metadata }];
                },
                async download() {
                    if (bucket.beforeDownload) { const hook = bucket.beforeDownload; bucket.beforeDownload = null; await hook(); }
                    const record = files.get(name);
                    if (!record || options.generation && String(record.generation) !== String(options.generation)) throw error(404);
                    return [Buffer.from(record.data)];
                },
                async save(data, config) {
                    const current = files.get(name);
                    if (String(current?.generation || 0) !== String(config.preconditionOpts.ifGenerationMatch)) throw error(412);
                    files.set(name, { data, generation: ++generation, metadata: config.metadata });
                },
            };
        },
        async getFiles({ prefix, pageToken = '0' }) {
            const matching = [...files.entries()].filter(([name]) => name.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
            const offset = Number(pageToken), selected = matching.slice(offset, offset + 2);
            return [selected.map(([name, value]) => ({ name, metadata: value.metadata })), offset + 2 < matching.length ? { pageToken: String(offset + 2) } : null];
        },
    };
}

const application = (id, overrides = {}) => ({ id, revision: 1, work: { state: 'idle', nextAttemptAt: 0, leaseUntil: 0 }, ...overrides });

test('atomic create cannot overwrite an existing application or expose a mutable shared record', async () => {
    const store = createStore({ bucket: memoryBucket() });
    assert.equal(await store.create('sub_First', application('sub_First')), true);
    assert.equal(await store.create('sub_First', application('sub_First', { revision: 9 })), false);
    const record = await store.read('sub_First'); record.revision = 30;
    assert.equal((await store.read('sub_First')).revision, 1);
    assert.equal(await store.read('sub_Missing'), null);
});

test('concurrent decisions compare revisions and generation so only one writer succeeds', async () => {
    const store = createStore({ bucket: memoryBucket() });
    await store.create('sub_First', application('sub_First'));
    const results = await Promise.all([
        store.compareAndSwap('sub_First', 1, application('sub_First', { revision: 2, state: 'approved' })),
        store.compareAndSwap('sub_First', 1, application('sub_First', { revision: 2, state: 'declined' })),
    ]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal((await store.read('sub_First')).revision, 2);
    assert.equal(await store.compareAndSwap('sub_First', 1, application('sub_First', { revision: 2 })), false);
});

test('a generation disappearing during a download retries a fresh version', async () => {
    const bucket = memoryBucket(), store = createStore({ bucket });
    await store.create('sub_First', application('sub_First'));
    bucket.beforeDownload = async () => { await store.compareAndSwap('sub_First', 1, application('sub_First', { revision: 2 })); };
    assert.equal((await store.read('sub_First')).revision, 2);
});

test('invalid IDs, record identity, revisions and oversized records fail before write', async () => {
    const bucket = memoryBucket(), store = createStore({ bucket });
    for (const id of ['../sub_First', 'sub_A/b', 'customer123', 'sub_']) await assert.rejects(store.create(id, application(id)));
    await assert.rejects(store.create('sub_First', application('sub_Other')));
    await assert.rejects(store.create('sub_First', application('sub_First', { revision: -1 })));
    await assert.rejects(store.create('sub_First', application('sub_First', { text: 'a'.repeat(MAX_RECORD_BYTES) })));
    await assert.rejects(store.compareAndSwap('sub_First', 1, application('sub_First', { revision: 3 })));
    assert.equal(bucket.files.size, 0);
});

test('due work scans all pages, ignores unrelated paths and selects oldest expired leases first', async () => {
    const bucket = memoryBucket(), store = createStore({ bucket });
    const states = [
        ['sub_A', 'queued', 80, 0], ['sub_B', 'leased', 20, 90], ['sub_C', 'leased', 10, 200],
        ['sub_D', 'queued', 200, 0], ['sub_E', 'idle', 0, 0], ['sub_F', 'attention', 0, 0], ['sub_G', 'queued', 20, 0],
    ];
    for (const [id, state, nextAttemptAt, leaseUntil] of states) await store.create(id, application(id, { work: { state, nextAttemptAt, leaseUntil } }));
    bucket.files.set('_sponsorships/v2/state.json', { data: 'private unrelated data', generation: 80 });
    assert.deepEqual((await store.listDue({ now: 100, limit: 2 })).map((r) => r.id), ['sub_B', 'sub_G']);
    assert.deepEqual((await store.listDue({ now: 100, limit: 20 })).map((r) => r.id), ['sub_B', 'sub_G', 'sub_A']);
});

test('storage outages propagate rather than returning empty state or false conflicts', async () => {
    const bucket = { file() { return { async getMetadata() { throw Object.assign(new Error('unavailable'), { code: 503 }); }, async save() { throw Object.assign(new Error('unavailable'), { code: 503 }); } }; }, async getFiles() { throw new Error('unavailable'); } };
    const store = createStore({ bucket });
    await assert.rejects(store.read('sub_First'), /unavailable/);
    await assert.rejects(store.create('sub_First', application('sub_First')), /unavailable/);
    await assert.rejects(store.listDue(), /unavailable/);
});
