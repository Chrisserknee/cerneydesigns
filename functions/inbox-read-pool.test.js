'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createReadPool} = require('./inbox-read-pool');
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('a cold inbox bounds simultaneous downloads without dropping or reordering records', async () => {
    const read = createReadPool();
    let active = 0, peak = 0;
    const results = await Promise.all(Array.from({length:700}, (_, i) => read(String(i), async () => {
        active++; peak = Math.max(peak, active);
        await nextTurn(); active--; return i;
    })));
    assert.equal(peak,16);
    assert.deepEqual(results,Array.from({length:700}, (_, i) => i));
});

test('overlapping refreshes share a download, but a new generation is read separately', async () => {
    const read = createReadPool(); let downloads = 0;
    const work = async () => { downloads++; await nextTurn(); return downloads; };
    const first = read('tip:1',work), duplicate = read('tip:1',work), changed = read('tip:2',work);
    assert.equal(first,duplicate); assert.notEqual(first,changed);
    await Promise.all([first,duplicate,changed]); assert.equal(downloads,2);
});

test('a failed download releases its slot and can be retried', async () => {
    const read = createReadPool(1);
    const failed = read('first',async () => { throw Error('unavailable'); });
    const next = read('second',async () => 'second');
    await assert.rejects(failed,/unavailable/); assert.equal(await next,'second');
    assert.equal(await read('first',async () => 'recovered'),'recovered');
});
