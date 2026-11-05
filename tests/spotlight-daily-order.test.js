'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { order, dayNumber } = require('../localspotlight/daily-order');
const businesses = ['Crema', 'Good Roots', 'Paint Store', 'Redwood', 'Wholehearted'].map((businessName, i) => ({ id: `business-${i}`, businessName }));
const ids = rows => rows.map(row => row.id);

test('stable within a Pacific day and independent of API ordering, without mutating input', () => {
    const input = [...businesses].reverse();
    const before = [...input];
    const morning = order(input, new Date('2026-11-04T08:01:00Z'));
    assert.deepEqual(ids(morning), ids(order(businesses, new Date('2026-11-05T07:59:59Z'))));
    assert.deepEqual(input, before);
    assert.notDeepEqual(ids(morning), ids(order(input, new Date('2026-11-05T08:00:00Z'))));
});

test('every business gets first position once per cycle, including a newly added business', () => {
    for (const input of [businesses, [...businesses, { id: 'new', businessName: 'New local business' }]]) {
        const firsts = new Set();
        for (let day = 0; day < input.length; day++) {
            const result = order(input, new Date(Date.UTC(2026, 10, 4 + day, 20)));
            assert.deepEqual([...ids(result)].sort(), [...ids(input)].sort());
            firsts.add(result[0].id);
        }
        assert.equal(firsts.size, input.length);
    }
});

test('Pacific midnight and daylight-saving transitions use calendar days', () => {
    for (const [start, end, next] of [
        ['2026-03-08T08:00:00Z', '2026-03-09T06:59:59Z', '2026-03-09T07:00:00Z'],
        ['2026-11-01T07:00:00Z', '2026-11-02T07:59:59Z', '2026-11-02T08:00:00Z'],
    ]) {
        assert.equal(dayNumber(new Date(start)), dayNumber(new Date(end)));
        assert.equal(dayNumber(new Date(next)), dayNumber(new Date(start)) + 1);
    }
});

test('empty, singleton and duplicate names remain deterministic', () => {
    assert.deepEqual(order([]), []);
    assert.deepEqual(order([businesses[0]]), [businesses[0]]);
    const sameNames = [{ id: 'b', businessName: 'Same name' }, { id: 'a', businessName: 'Same name' }];
    assert.deepEqual(ids(order(sameNames)), ids(order([...sameNames].reverse())));
});
