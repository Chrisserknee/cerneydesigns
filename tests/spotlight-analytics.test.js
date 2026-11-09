const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../localspotlight/analytics.js'), 'utf8');

function browser(href, enabled = false) {
    const listeners = {};
    const scripts = [];
    const window = { location: { href } };
    const context = vm.createContext({
        URL, window, WeakSet,
        document: {
            querySelector: () => scripts[0] || null,
            addEventListener: (name, callback) => { listeners[name] = callback; },
            createElement: () => ({}),
            head: { appendChild: (script) => scripts.push(script) },
        },
    });
    const run = () => vm.runInContext(source.replace(/const customEventsEnabled = (true|false)/, `const customEventsEnabled = ${enabled}`), context);
    run();
    return { window, scripts, run, listeners, beforeSend: window.vaq?.[0]?.[1] };
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
    for (const url of ['https://cerneyselects.com/book/?token=private', 'https://chriscerney.org/admin/', 'invalid']) {
        assert.equal(beforeSend({ type: 'pageview', url }), null);
    }
    assert.equal(beforeSend({ type: 'event', url: 'https://cerneyselects.com/', payload: { email: 'private' } }), null);
});


test('reporting pages track pageviews including www and trailing slash aliases', () => {
    for (const path of ['/', '/news/', '/news/privacy.html', '/upload', '/submit-story/', '/community-help/', '/portfolio/index.html', '/merchandise/', '/newsroom/']) {
        assert.equal(browser('https://www.chriscerney.org' + path).scripts.length, 1, path);
    }
    for (const path of ['/admin/', '/account/', '/tip-alerts/', '/book/', '/api/news', '/unknown/']) assert.equal(browser('https://chriscerney.org' + path).scripts.length, 0, path);
});

test('custom events remain disabled until a supported plan is approved', () => {
    const page = browser('https://cerneyselects.com/');
    const el = {dataset:{analyticsAction:'business_open',analyticsTarget:'example business'}};
    page.listeners.click({target:{closest:()=>el}});
    assert.equal(page.window.vaq.length, 1);
});

test('enabled events redact URL secrets and drop unknown properties and names', () => {
    const page = browser('https://cerneyselects.com/?secret=x', true);
    const event = {type:'event', url:'https://cerneyselects.com/?secret=x#private', payload:{name:'Site interaction',data:{action:'business_open', target:'example business',email:'private@example.com'}}};
    const clean=page.beforeSend(event);
    assert.equal(clean.url,'https://cerneyselects.com/');
    assert.deepEqual(Object.keys(clean.payload.data),['action','target']);
    assert.equal(page.beforeSend({...event,payload:{...event.payload,name:'arbitrary'}}),null);
    assert.equal(page.beforeSend({...event,payload:{...event.payload,data:{action:'business_open',target:'private@example.com'}}}),null);
    assert.equal(page.beforeSend({...event,url:'https://cerneyselects.com/spotlightreview/'}),null);
});

function click(page, {dataset={},href=null,business=null,id='',classes=[]}={}) {
    const el={dataset,id,classList:{contains:v=>classes.includes(v)},getAttribute:()=>href,closest:()=>business?{dataset:{analyticsBusiness:business}}:null};
    page.listeners.click({target:{closest:()=>el}});
    return page.window.vaq.at(-1);
}
test('business actions distinguish opens, calls, websites and socials without contact data',()=>{
    const page=browser('https://cerneyselects.com/',true);
    assert.equal(click(page,{dataset:{analyticsAction:'business_open',analyticsTarget:'example'}})[1].data.action,'business_open');
    for(const [href,action] of [['tel:8315551234','business_call'],['https://example.com/?private=x','business_website'],['https://www.instagram.com/example','business_social']]) {
        const result=click(page,{href,business:'example'})[1];assert.equal(result.data.action,action);assert.equal(result.data.target,'example');assert.ok(!JSON.stringify(result).includes(href));
    }
});
test('navigation and category clicks use controlled destinations, never query values',()=>{
    const page=browser('https://cerneyselects.com/',true);
    assert.equal(click(page,{href:'#category/professional-services'})[1].data.target,'professional-services');
    assert.equal(click(page,{href:'/apply/?session_id=secret'})[1].data.target,'apply');
    const count=page.window.vaq.length;click(page,{href:'/admin/?token=secret'});assert.equal(page.window.vaq.length,count);
});
test('news controls and video starts use no input values and videos count once per element',()=>{
    const page=browser('https://chriscerney.org/news/',true);
    assert.equal(click(page,{dataset:{view:'video'}})[1].data.action,'news_filter');
    assert.equal(click(page,{classes:['account-button']})[1].data.action,'news_join');
    const video={tagName:'VIDEO',src:'private-filename'};page.listeners.play({target:video});const count=page.window.vaq.length;page.listeners.play({target:video});assert.equal(page.window.vaq.length,count);assert.equal(page.window.vaq.at(-1)[1].data.target,'news');
    click(page,{id:'send-private-tip'});assert.equal(page.window.vaq.length,count);
});
