const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function client({ tip = false, serviceWorker, respond, ios = false } = {}) {
    const elements = new Map(), calls = [], destinations = [];
    const element = () => ({ hidden: false, children: [], handlers: {}, classList: { toggle() {} },
        replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); },
        addEventListener(name, callback) { this.handlers[name] = callback; } });
    const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
    const context = vm.createContext({
        document: { getElementById: get, createElement: element, addEventListener() {}, hidden: false },
        navigator: { userAgent: ios ? 'iPhone' : 'test', ...(serviceWorker ? { serviceWorker } : {}) }, window: {},
        matchMedia: () => ({ matches: false }), URL, URLSearchParams, Intl, Date, Uint8Array,
        setTimeout: (fn, ms) => { const timer=setTimeout(fn,ms); timer.unref(); return timer; }, clearTimeout,
        location: { search: tip ? '?tip=' + 'a'.repeat(64) : '', replace: url => destinations.push(url) },
        fetch: async (_, options) => {
            const { op } = JSON.parse(options.body); calls.push(op);
            const answer = await respond?.(op) || { status: 200, body: op === 'status' ? { subscribed: true, expiresAt: null } : { tips: [] } };
            return { ok: answer.status === 200, status: answer.status, json: async () => answer.body };
        },
    });
    const source = fs.readFileSync(__dirname + '/../tip-alerts/app.js', 'utf8').replace(/load\(\);\s*$/, 'globalThis.started = load();');
    vm.runInContext(source, context);
    return { elements, calls, destinations, ready: context.started, run: code => vm.runInContext(code, context) };
}

test('notification arrival offers a direct Drive app tap without automatic web navigation', async () => {
    const c = client({ tip: true, ios: true,
        respond: op => op === 'tip' ? { status: 200, body: { tips: [{ driveUrl: 'https://drive.google.com/drive/folders/test' }] } } : null });
    await c.ready;
    assert.deepEqual(c.calls, ['status','list','tip']);
    assert.deepEqual(c.destinations, []);
    assert.equal(c.elements.get('selected').children.at(-1).href, 'googledrive://https://drive.google.com/drive/folders/test');
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

test('recent tips render before a slow notification status response completes', async () => {
    let release;
    const c=client({ respond: op => op==='status' ? new Promise(resolve=>{release=resolve;}) : null });
    for(let i=0;i<20;i++) await Promise.resolve();
    assert.ok(c.calls.includes('list'));
    assert.equal(c.elements.get('connected').hidden,false);
    assert.match(c.elements.get('inboxStatus').textContent,/0 recent tips/);
    release({status:200,body:{subscribed:true,expiresAt:null}}); await c.ready;
});

test('an in-flight inbox cannot restore content after revocation', async () => {
    let release;
    const c=client({ respond: op=>op==='list' ? new Promise(resolve=>{release=resolve;}) : {status:401,body:{error:'Sign in again.'}} });
    for(let i=0;i<20;i++) await Promise.resolve();
    release({status:200,body:{tips:[{driveUrl:'https://drive.google.com/drive/folders/test',receivedAt:new Date().toISOString()}]}});
    await c.ready;
    assert.equal(c.elements.get('connected').hidden,true);
    assert.deepEqual(c.elements.get('tips').children,[]);
});

test('newly available folders stay in the inbox until explicitly tapped', async () => {
    let ready=false;
    const c=client({tip:true,ios:true,respond:op=>op==='tip' ? {status:200,body:{tips:[{status:'processing',driveUrl:ready?'https://drive.google.com/drive/folders/newFolder':null}]}}:null});
    await c.ready; ready=true; await c.run('openTip()');
    assert.deepEqual(c.destinations,[]);
    assert.equal(c.elements.get('selected').children.at(-1).href,'googledrive://https://drive.google.com/drive/folders/newFolder');
    c.run('clearTimeout(retryTimer)');
});

test('repeated refreshes share one request and unsafe folder links are rejected', async()=>{
    const c=client(); await c.ready;
    await Promise.all([c.run('loadTips()'),c.run('loadTips()')]);
    assert.equal(c.calls.filter(op=>op==='list').length,2);
    for(const url of ['javascript:alert(1)','https://drive.google.com.evil.test/drive/folders/x','https://user@drive.google.com/drive/folders/x','https://drive.google.com:444/drive/folders/x']) {
        assert.equal(c.run(`folderURL(${JSON.stringify(url)})`),null);
    }
});
