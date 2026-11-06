'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { groups, display } = require('../localspotlight/categories');

test('all ten stored categories belong to exactly one of five display groups', () => {
    assert.equal(groups.length, 5);
    const values = groups.flatMap(group => group.values);
    assert.equal(values.length, 10);
    assert.equal(new Set(values).size, 10);
    for (const group of groups) {
        assert.equal(display(group.label), group.label);
        for (const value of group.values) assert.equal(display(value), group.label);
    }
    assert.equal(display('Unknown category'), 'Unknown category');
    assert.equal(display('Home & Auto Services'), 'Professional Services');
});

test('signup transports accepted legacy values while showing the five new labels', () => {
    const html = fs.readFileSync(path.join(__dirname, '../spotlightsignup/index.html'), 'utf8');
    const select = html.match(/<select id="category"[^>]*>(.*?)<\/select>/s)[1];
    const options = [...select.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)];
    assert.equal(options.length, 5);
    for (const [i, option] of options.entries()) {
        assert.equal(option[1].replaceAll('&amp;', '&'), groups[i].values[0]);
        assert.equal(option[2].replaceAll('&amp;', '&'), groups[i].label);
    }
});
