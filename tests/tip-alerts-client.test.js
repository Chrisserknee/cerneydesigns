const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function client({ tip = false, serviceWorker, respond, ios = false, homeScreen = true } = {}) {
    const elements = new Map(), calls = [], destinations = [], events = {}, timers = [];
    const element = () => ({ hidden: false, children: [], handlers: {}, classList: { toggle() {} },
        replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); },
        addEventListener(name, callback) { this.handlers[name] = callback; } });
    const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
    const context = vm.createContext({
        document: { documentElement: { classList: {toggle(){}}, style: {setProperty(){}} }, getElementById: get, createElement: element, addEventListener: (name,fn) => { events[name]=fn; }, hidden: false },
        navigator: { userAgent: ios ? 'iPhone' : 'test', ...(serviceWorker ? { serviceWorker } : {}) }, window: {scrollY:0, addEventListener: (name,fn) => {events[name]=fn;}},
        matchMedia: () => ({ matches: homeScreen }), URL, URLSearchParams, AbortSignal, Intl, Date, Uint8Array,
        requestAnimationFrame: fn=>setTimeout(fn,0), cancelAnimationFrame: clearTimeout,
        setTimeout: (fn, ms) => { timers.push({fn,ms}); const timer=setTimeout(fn,ms); timer.unref(); return timer; }, clearTimeout,
        location: { search: tip ? '?tip=' + 'a'.repeat(64) : '', replace: url => destinations.push(url) },
        fetch: async (_, options) => {
            const { op } = JSON.parse(options.body); calls.push(op);
            const answer = await respond?.(op) || { status: 200, body: op === 'status' ? { subscribed: true, expiresAt: null } : { tips: [] } };
            return { ok: answer.status === 200, status: answer.status, json: async () => answer.body };
        },
    });
    const source = fs.readFileSync(__dirname + '/../tip-alerts/app.js', 'utf8').replace(/load\(\);\s*$/, 'globalThis.started = load();');
    vm.runInContext(source, context);
    return { elements, calls, destinations, events, timers, ready: context.started, run: code => vm.runInContext(code, context) };
}

test('notification arrival offers a direct Drive app tap without automatic web navigation', async () => {
    const c = client({ tip: true, ios: true,
        respond: op => op === 'tip' ? { status: 200, body: { tips: [{ driveUrl: 'https://drive.google.com/drive/folders/test' }] } } : null });
    await c.ready;
    assert.deepEqual(c.calls, ['list','tip']);
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
    await c.run('refreshInbox()');
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

test('startup requests only the authenticated inbox, without push configuration', async()=>{
    const c=client();await c.ready;
    assert.deepEqual(c.calls,['list']);
    assert.equal(c.elements.get('connected').hidden,false);
});

test('an in-flight inbox cannot restore content after revocation', async () => {
    let release;
    const c=client({ respond: op=>op==='list' ? new Promise(resolve=>{release=resolve;}) : {status:401,body:{error:'Sign in again.'}} });
    for(let i=0;i<20;i++) await Promise.resolve();
    c.run('clearSession()');
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

function touch(y,x=0){return {touches:[{clientX:x,clientY:y}],target:{closest:()=>null},cancelable:true,preventDefault(){this.prevented=true;}};}
test('pull from top refreshes once only when released beyond the threshold',async()=>{
 const c=client();await c.ready;
 c.events.touchstart(touch(20));const move=touch(120);c.events.touchmove(move);
 assert.equal(move.prevented,true);assert.equal(c.elements.get('pullIndicator').textContent,'Release to refresh');
 assert.equal(c.calls.length,1);c.events.touchend();await c.run('refreshRequest');
 assert.equal(c.calls.length,2);assert.equal(c.elements.get('pullIndicator').hidden,true);
 c.events.touchend();assert.equal(c.calls.length,2);
});
test('small, cancelled, horizontal and scrolled gestures never refresh',async()=>{
 const c=client();await c.ready;
 c.events.touchstart(touch(0));c.events.touchmove(touch(30));c.events.touchend();
 c.events.touchstart(touch(0));c.events.touchmove(touch(100));c.events.touchcancel();c.events.touchend();
 c.events.touchstart(touch(0));c.events.touchmove(touch(80,150));c.events.touchend();
 c.run('window.scrollY=100');c.events.touchstart(touch(0));c.events.touchmove(touch(100));c.events.touchend();
 assert.equal(c.calls.length,1);
});
test('a failed automatic refresh schedules recovery and keeps existing tips visible',async()=>{
 let fail=false;const c=client({respond:()=>fail?{status:503,body:{error:'Unavailable'}}:null});await c.ready;
 c.elements.get('tips').children=['existing tips'];fail=true;
 await c.run('refreshInbox()');
 assert.deepEqual(c.elements.get('tips').children,['existing tips']);
 assert.equal(c.timers.at(-1).ms,10000);
 fail=false;await c.timers.at(-1).fn();
 assert.equal(c.timers.at(-1).ms,30000);
 assert.equal(c.elements.get('message').textContent,'');
});

test('regular Safari has no custom gesture handlers',async()=>{
 const c=client({homeScreen:false,ios:true});await c.ready;
 assert.equal(c.events.touchstart,undefined);assert.equal(c.events.touchmove,undefined);
});
test('unchanged auto refresh preserves the actual rendered card nodes',async()=>{
 const record={type:'upload',receivedAt:new Date().toISOString(),status:'ready',driveUrl:'https://drive.google.com/drive/folders/test'};
 const c=client({respond:()=>({status:200,body:{tips:[record]}})});await c.ready;
 const row=c.elements.get('tips').children[0];await c.run('loadTips({quiet:true})');
 assert.equal(c.elements.get('tips').children[0],row);
 record.status='processing';await c.run('loadTips({quiet:true})');
 assert.notEqual(c.elements.get('tips').children[0],row);
});
