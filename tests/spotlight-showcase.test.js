'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const categories = require('../localspotlight/categories');
const daily = require('../localspotlight/daily-order');
const source = fs.readFileSync(path.join(__dirname, '../localspotlight/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../localspotlight/index.html'), 'utf8');

class Element {
    constructor(tag = 'div') {
        this.tag = tag; this.children = []; this.attrs = {}; this.events = {}; this.dataset = {}; this.className = '';
        this.classList = {
            contains: value => this.className.split(' ').includes(value),
            add: value => { if (!this.classList.contains(value)) this.className += ' ' + value; },
            remove: value => { this.className = this.className.split(' ').filter(x => x !== value).join(' '); },
            toggle: (value, on) => on ? this.classList.add(value) : this.classList.remove(value),
        };
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k]; }
    addEventListener(name, fn) { this.events[name] = fn; }
    get childElementCount() { return this.children.length; }
    focus() { this.focused = true; }
    showModal() { this.open = true; }
    close() { this.open = false; this.events.close?.(); }
    remove() { this.removed = true; }
}
const descendants = element => element.children.flatMap(child => [child, ...descendants(child)]);
const byClass = (element, name) => descendants(element).filter(child => child.classList.contains(name));
async function browser(listings, hash = '') {
    const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
    const body = new Element('body'); body.className = 'directory-first category-showcase';
    const events = {}, intervals = [], calls = [];
    let response = { ok: true, listings }, date = new Date('2026-11-06T20:00:00Z');
    const window = {
        location: { origin: 'https://cerneyselects.com', pathname: '/', hash },
        matchMedia: () => ({ matches: true, addEventListener() {} }),
        addEventListener: (name, fn) => { events[name] = fn; }, scrollTo() {},
        CerneySelectsCategories: categories,
        CerneySelectsDailyOrder: { order: items => daily.order(items, date), dayNumber: () => daily.dayNumber(date) },
        CerneySelectsSocials: { platforms: [{ field: 'instagram' }] },
        CerneySelectsSocialLinks: () => null,
        CerneySelectsPhone: phone => ({ href: 'tel:' + phone, display: phone }),
    };
    const context = vm.createContext({
        window, document: { body, getElementById: id => elements[id] || null, createElement: tag => new Element(tag), querySelectorAll: () => [], addEventListener() {} },
        URL, AbortController, setTimeout: () => 1, clearTimeout() {}, setInterval: fn => intervals.push(fn),
        fetch: async (url, options) => { calls.push({ url, options }); return { ok: response.ok, json: async () => ({ listings: response.listings }) }; },
    });
    vm.runInContext(source, context);
    const settle = () => new Promise(resolve => setImmediate(resolve));
    await settle();
    return { elements, window, calls, settle, sections: () => elements.businessGrid.children,
        navigate(hash) { window.location.hash = hash; events.hashchange(); },
        nextDay() { date = new Date(date.getTime() + 86400000); intervals.forEach(fn => fn()); },
        respond(value) { response = value; },
    };
}
const listing = (i, category = 'Professional Services') => ({ id: 'test-' + i, businessName: 'Test Business ' + i, category, city: 'Monterey', logoUrl: 'https://images.example.com/logo-' + i + '.png', bannerUrl: '/localspotlight/banners/example.webp', description: 'Business bio', address: '123 Example St, Monterey', website: 'https://example.com', phone: '8315550100' });

test('live response renders all 18 businesses across five ranked categories, including home and auto', async () => {
    const records = Array.from({ length: 18 }, (_, i) => listing(i, i < 10 ? 'Professional Services' : ['Home & Property', 'Auto & Transportation', 'Food & Restaurants', 'Drinks & Nightlife', 'Shopping & Local Makers', 'Farms, Outdoors & Local Living', 'Family & Community', 'Health & Wellness'][i - 10]));
    const page = await browser(records);
    assert.equal(page.calls[0].url, '/api/spotlight');
    assert.equal(page.calls[0].options.cache, 'no-store');
    assert.equal(page.sections().length, 5);
    assert.deepEqual(page.sections().map(s => byClass(s, 'business-tile').length), [12, 2, 2, 1, 1]);
    assert.equal(byClass(page.elements.businessGrid, 'business-tile').length, 18);
    assert.equal(new Set(byClass(page.elements.businessGrid, 'expanded-logo').map(img => img.src)).size, 18);
    for (const section of page.sections()) {
        const link = byClass(section, 'category-invitation')[0];
        const count = byClass(section, 'business-tile').length;
        page.navigate(link.href);
        assert.equal(page.sections().length, 1);
        assert.equal(byClass(page.elements.businessGrid, 'business-tile').length, count);
        assert.equal(page.elements.categoryBack.hidden, false);
        assert.equal(page.elements.directoryTitle.focused, true);
        page.navigate('#businesses');
    }
    page.navigate('#category/no-such-category');
    assert.equal(page.sections().length, 5);
    const order = () => byClass(page.sections()[0], 'business-tile').map(tile => tile.attrs['aria-label']);
    const before = order(); page.nextDay(); assert.notDeepEqual(order(), before);
});

test('deep links, detail dialog, safe logos and normal About navigation remain usable', async () => {
    const profile = listing(0, 'Shopping & Local Makers');
    profile.businessName = 'Sharp Corners Sports Cards & Collectibles';
    const page = await browser([profile, { ...listing(1), logoUrl: 'javascript:alert(1)' }], '#category/shopping-local-goods');
    const tile = byClass(page.elements.businessGrid, 'business-tile')[0];
    assert.match(tile.attrs['aria-label'], /Sharp Corners Sports Cards & Collectibles/);
    assert.equal(byClass(tile, 'business-tile-name')[0].textContent, 'Sharp Corners');
    tile.events.click();
    assert.equal(page.elements.businessDialog.open, true);
    const content = page.elements.businessDialogContent;
    assert.equal(byClass(content, 'directory-banner')[0].src, 'https://cerneyselects.com/localspotlight/banners/example.webp');
    const children = byClass(content, 'directory-card-body')[0].children;
    assert.ok(children.indexOf(byClass(content, 'directory-description')[0]) < children.indexOf(byClass(content, 'directory-address')[0]));
    assert.equal(byClass(content, 'directory-phone')[0].href, 'tel:8315550100');
    page.elements.closeBusinessDialog.events.click(); assert.equal(page.elements.businessDialog.open, false);
    page.navigate('#about'); assert.equal(page.sections().length, 5);
    const images = byClass(page.elements.businessGrid, 'expanded-logo');
    assert.equal(images.length, 2);
    assert.ok(images.every(image => image.src.startsWith('https://')));
    const fallback = byClass(page.elements.businessGrid, 'is-banner-fallback');
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].src, 'https://cerneyselects.com/localspotlight/banners/example.webp');
});

test('empty categories remain visible and a failed request can be retried without filters', async () => {
    const page = await browser(null);
    assert.equal(page.elements.directoryEmpty.hidden, false);
    assert.equal(page.elements.retryDirectory.hidden, false);
    page.respond({ ok: true, listings: [] });
    await page.elements.retryDirectory.events.click();
    assert.equal(page.sections().length, 5);
    assert.equal(byClass(page.elements.businessGrid, 'category-empty').length, 5);
    assert.equal(page.elements.directoryEmpty.hidden, true);
    assert.equal(page.elements.businessSearch, undefined);
    assert.equal(page.elements.cityFilter, undefined);
});

test('verified partner badge renders on the card and detail view, unknown labels are ignored', async () => {
    const page = await browser([{ ...listing(0), membershipBadge: 'exclusive-construction' }, { ...listing(1), membershipBadge: '<script>fake</script>' }]);
    const badges = byClass(page.elements.businessGrid, 'membership-badge');
    assert.equal(badges.length, 1);
    assert.equal(byClass(badges[0], 'membership-badge-title')[0].textContent, 'Construction Partner');
    const tile = byClass(page.elements.businessGrid, 'has-membership-badge')[0];
    assert.match(tile.attrs['aria-label'], /Exclusive Construction Partner/);
    tile.events.click();
    assert.equal(byClass(page.elements.businessDialogContent, 'membership-badge').length, 1);
});
