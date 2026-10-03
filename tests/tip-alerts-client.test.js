const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function client({ tip = false, serviceWorker, respond } = {}) {
    const elements = new Map(), calls = [], destinations = [];
    const element = () => ({ hidden: false, children: [], handlers: {}, classList: { toggle() {} },
        replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); },
        addEventListener(name, callback) { this.handlers[name] = callback; } });
    const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
    const context = vm.createContext({
        document: { getElementById: get, createElement: element, addEventListener() {}, hidden: false },
        navigator: { userAgent: 'test', ...(serviceWorker ? { serviceWorker } : {}) }, window: {},
        matchMedia: () => ({ matches: false }), URLSearchParams, Intl, Date, Uint8Array,
        setTimeout, clearTimeout,
        location: { search: tip ? '?tip=' + 'a'.repeat(64) : '', replace: url => destinations.push(url) },
        fetch: async (_, options) => {
            const { op } = JSON.parse(options.body); calls.push(op);
            const answer = respond?.(op) || { status: 200, body: op === 'status' ? { subscribed: true, expiresAt: null } : { tips: [] } };
            return { ok: answer.status === 200, status: answer.status, json: async () => answer.body };
        },
    });
    const source = fs.readFileSync(__dirname + '/../tip-alerts/app.js', 'utf8').replace(/load\(\);\s*$/, 'globalThis.started = load();');
    vm.runInContext(source, context);
    return { elements, calls, destinations, ready: context.started, run: code => vm.runInContext(code, context) };
}

test('alert opens its folder before requesting inbox or notification setup', async () => {
    const c = client({ tip: true, serviceWorker: { register() { throw new Error('must not block navigation'); } },
        respond: op => op === 'tip' ? { status: 200, body: { tips: [{ driveUrl: 'https://drive.google.com/drive/folders/test' }] } } : null });
    await c.ready;
    assert.deepEqual(c.calls, ['status','tip']);
    assert.deepEqual(c.destinations, ['https://drive.google.com/drive/folders/test']);
});

test('sign-out clears private content even when browser push cleanup fails', async () => {
    const c = client(); await c.ready;
    c.elements.get('tips').children = ['private contents'];
    c.run('registration = { pushManager: { getSubscription: async () => { throw new Error("browser failure"); } } }');
    await c.elements.get('logout').handlers.click();
    assert.equal(c.elements.get('connected').hidden, true);
    assert.deepEqual(c.elements.get('tips').children, []);
    assert.equal(c.run('state'), null);
    assert.deepEqual(c.destinations, ['/tip-alerts/']);
});

test('revoked device clears old inbox on the next failed request', async () => {
    let revoked = false;
    const c = client({ respond: () => revoked ? { status: 401, body: { error: 'Sign in again.' } } : null });
    await c.ready; c.elements.get('tips').children = ['private contents']; revoked = true;
    await c.elements.get('refresh').handlers.click();
    assert.equal(c.elements.get('login').hidden, false);
    assert.equal(c.elements.get('connected').hidden, true);
    assert.deepEqual(c.elements.get('tips').children, []);
});

test('inbox loads independently of a slow service worker', async () => {
    let release;
    const worker = { register: async () => ({}), ready: new Promise(resolve => { release = resolve; }) };
    const c = client({ serviceWorker: worker });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.ok(c.calls.includes('list'));
    release({}); await c.ready;
});
