const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../localspotlight/analytics.js'), 'utf8');

function browser(href) {
    const scripts = [];
    const window = { location: { href } };
    const context = vm.createContext({
        URL, window,
        document: {
            querySelector: () => scripts[0] || null,
            createElement: () => ({}),
            head: { appendChild: (script) => scripts.push(script) },
        },
    });
    const run = () => vm.runInContext(source, context);
    run();
    return { window, scripts, run, beforeSend: window.vaq?.[0]?.[1] };
}

test('public pages load the same-origin collector once', () => {
    for (const route of ['/', '/apply', '/apply/', '/privacy/', '/terms/']) {
        const page = browser('https://cerneyselects.com' + route);
        page.run();
        assert.equal(page.scripts.length, 1);
        assert.equal(page.scripts[0].src, '/_vercel/insights/script.js');
        assert.equal(page.scripts[0].defer, true);
        assert.equal(page.window.vaq.length, 1);
    }
});

test('private pages, previews, other domains, and local pages never load analytics', () => {
    for (const href of [
        'https://cerneyselects.com/book/',
        'https://cerneyselects.com/spotlightreview/?token=private',
        'https://cerneyselects.com/admin/spotlight/',
        'https://cerneyselects.com/localspotlight/preview/',
        'https://preview.cerneyselects.com/',
        'https://chriscerney.org/',
        'https://cerneydesigns-example.vercel.app/',
        'http://localhost/',
        'file:///tmp/index.html',
    ]) {
        const page = browser(href);
        assert.equal(page.scripts.length, 0, href);
        assert.equal(page.window.va, undefined, href);
    }
});

test('page views redact checkout identifiers, email, query strings, and fragments', () => {
    const { beforeSend } = browser('https://cerneyselects.com/apply/?session_id=private#manage');
    const event = { type: 'pageview', url: 'https://cerneyselects.com/apply/?session_id=private&email=person@example.com#manage' };
    const cleaned = beforeSend(event);
    assert.equal(cleaned.url, 'https://cerneyselects.com/apply/');
    assert.equal(cleaned.type, 'pageview');
    assert.match(event.url, /session_id=private/);
});

test('navigation into private routes and custom events cannot leak into analytics', () => {
    const { beforeSend } = browser('https://cerneyselects.com/');
    for (const url of ['https://cerneyselects.com/book/?token=private', 'https://chriscerney.org/', 'invalid']) {
        assert.equal(beforeSend({ type: 'pageview', url }), null);
    }
    assert.equal(beforeSend({ type: 'event', url: 'https://cerneyselects.com/', payload: { email: 'private' } }), null);
});
