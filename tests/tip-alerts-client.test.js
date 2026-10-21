const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function client({ tip = false, serviceWorker, respond, ios = false, homeScreen = true, saved = new Map() } = {}) {
    const elements = new Map(), calls = [], destinations = [], events = {}, timers = [];
    const element = () => ({ hidden: false, children: [], handlers: {}, classList: { toggle() {} },
        replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); },
        setAttribute(name,value){this[name]=value;}, focus(){this.focused=true;}, select(){this.selected=true;}, setSelectionRange(a,b){this.selection=[a,b];}, addEventListener(name, callback) { this.handlers[name] = callback; } });
    const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
    const context = vm.createContext({
        document: { documentElement: { classList: {toggle(){}}, style: {setProperty(){}} }, getElementById: get, createElement: element, addEventListener: (name,fn) => { events[name]=fn; }, hidden: false },
        navigator: { userAgent: ios ? 'iPhone' : 'test', ...(serviceWorker ? { serviceWorker: {addEventListener:(name,fn)=>{events['worker:'+name]=fn;},...serviceWorker} } : {}) }, window: {scrollY:0, addEventListener: (name,fn) => {events[name]=fn;}},
        matchMedia: () => ({ matches: homeScreen }), URL, URLSearchParams, AbortSignal, Intl, Date, Uint8Array,
        requestAnimationFrame: fn=>setTimeout(fn,0), cancelAnimationFrame: clearTimeout,
        setTimeout: (fn, ms) => { timers.push({fn,ms}); const timer=setTimeout(fn,ms); timer.unref(); return timer; }, clearTimeout,
        location: { origin:'https://www.chriscerney.org', search: tip ? '?tip=' + 'a'.repeat(64) : '', replace: url => destinations.push(url) },
        history: {replaceState:(_,__,url)=>destinations.push(url)},
        localStorage:{getItem:key=>saved.get(key) || null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)},
        fetch: async (_, options) => {
            const { op } = JSON.parse(options.body); calls.push(op);
            const answer = await respond?.(op) || { status: 200, body: op === 'status' ? { subscribed: true, expiresAt: null } : { tips: [] } };
            return { ok: answer.status === 200, status: answer.status, json: async () => answer.body };
        },
    });
    vm.runInContext(fs.readFileSync(__dirname + '/../tip-alerts/thumbnail.js', 'utf8'), context);
    vm.runInContext(fs.readFileSync(__dirname + '/../tip-alerts/report-copy.js', 'utf8'), context);
    context.CerneyReportCopy=context.window.CerneyReportCopy;
    const source = fs.readFileSync(__dirname + '/../tip-alerts/app.js', 'utf8').replace(/load\(\);\s*$/, 'globalThis.started = load();');
    vm.runInContext(source, context);
    return { elements, calls, destinations, events, timers, ready: context.started, run: code => vm.runInContext(code, context) };
}

// Cards sit inside status groups: <section.story-group> holds [heading, .story-list, show-more?].
const cards=(c,id)=>c.elements.get(id).children.flatMap(group=>group.children?.[1]?.children ?? []);

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
 const row=cards(c,'tips')[0];await c.run('loadTips({quiet:true})');
 assert.equal(cards(c,'tips')[0],row);
 record.status='processing';await c.run('loadTips({quiet:true})');
 assert.notEqual(cards(c,'tips')[0],row);
});

test('Claude titles and context replace a generic card safely on automatic refresh',async()=>{
 const tip={id:'x',receivedAt:new Date().toISOString(),type:'upload',driveUrl:'https://drive.google.com/drive/folders/test'};
 const c=client({respond:()=>({status:200,body:{tips:[{...tip}]}})});await c.ready;
 Object.assign(tip,{title:'Bicycle riders in Monterey',summary:'<img src=x onerror=alert(1)>',contextSource:'claude',reportState:'ready'});
 await c.run('loadTips({quiet:true})');
 const info=cards(c,'tips')[0].children[0].children[0];
 assert.equal(info.children[1].textContent,tip.title);
 assert.equal(info.children.find(e=>e.className==='tip-summary').textContent,tip.summary);
 assert.match(info.children.find(e=>e.className==='tip-provenance').textContent,/Prepared draft/);
});


test('selected report copies the complete VO and caption instead of its summary',async()=>{
 const caption='A complete caption.\n\n'+('Important detail. '.repeat(60));
 const vo='Recording script.\n\n'+('More of the report. '.repeat(80));
 const c=client({tip:true,respond:op=>op==='tip'?{status:200,body:{tips:[{title:'Test',summary:'Short summary',driveUrl:'https://drive.google.com/drive/folders/test',instagramDescription:caption,voiceover:vo}]}}:null});
 await c.ready;c.run('globalThis.copied=[];navigator.clipboard={writeText:async text=>copied.push(text)}');
 const sections=c.elements.get('selected').children.filter(e=>e.className==='report-copy');
 assert.equal(sections.length,2);
 await sections[0].children.find(e=>e.className==='copy-actions').children[0].handlers.click();
 await sections[1].children.find(e=>e.className==='copy-actions').children[0].handlers.click();
 assert.equal(c.run('copied[0]'),caption);assert.equal(c.run('copied[1]'),vo);
});

test('clipboard denial selects the full text for manual copying',async()=>{
 const vo='Full recording script.\n\nSecond paragraph.';
 const c=client({tip:true,respond:op=>op==='tip'?{status:200,body:{tips:[{driveUrl:'https://drive.google.com/drive/folders/test',voiceover:vo}]}}:null});await c.ready;
 const section=c.elements.get('selected').children.find(e=>e.className==='report-copy');
 await section.children.find(e=>e.className==='copy-actions').children[0].handlers.click();
 assert.equal(section.open,true);assert.equal(section.children[2].value,vo);assert.equal(section.children[2].selection[1],vo.length);
});

test('a resumed inbox selects the report sent by its service worker',async()=>{
 const caption='Full report caption',vo='Complete recording script',id='b'.repeat(64);
 const worker={register:async()=>({}),ready:Promise.resolve({})};
 const c=client({ios:true,serviceWorker:worker,respond:op=>op==='tip'?{status:200,body:{tips:[{title:'Soledad report',driveUrl:'https://drive.google.com/drive/folders/report',instagramDescription:caption,voiceover:vo}]}}:null});
 await c.ready;
 c.events['worker:message']({origin:'https://www.chriscerney.org',data:{type:'cerney-tip-open',url:'https://www.chriscerney.org/tip-alerts/?tip='+id}});
 for(let i=0;i<20;i++)await Promise.resolve();
 assert.equal(c.run('tipId'),id);assert.equal(c.elements.get('selected').hidden,false);
 assert.equal(c.elements.get('selected').children[1].textContent,'Soledad report');
 assert.equal(c.elements.get('selected').children.find(e=>e.className==='folder').href,'googledrive://https://drive.google.com/drive/folders/report');
 assert.deepEqual(c.destinations,['/tip-alerts/?tip='+id]);
 assert.equal(c.elements.get('selected').children.filter(e=>e.className==='report-copy').length,2);
});

test('worker messages cannot select external, unrelated or malformed destinations',async()=>{
 const c=client({serviceWorker:{register:async()=>({}),ready:Promise.resolve({})}});await c.ready;
 for(const [origin,url] of [['https://evil.test','https://www.chriscerney.org/tip-alerts/?tip='+'a'.repeat(64)],['https://www.chriscerney.org','https://evil.test/tip-alerts/?tip='+'a'.repeat(64)],['https://www.chriscerney.org','https://www.chriscerney.org/admin/?tip='+'a'.repeat(64)],['https://www.chriscerney.org','https://www.chriscerney.org/tip-alerts/?tip=bad']])
  c.events['worker:message']({origin,data:{type:'cerney-tip-open',url}});
 assert.deepEqual(c.calls,['list']);assert.deepEqual(c.destinations,[]);
});

test('an earlier selected-report request cannot overwrite a newer notification',async()=>{
 let release,number=0;
 const c=client({serviceWorker:{register:async()=>({}),ready:Promise.resolve({})},respond:op=>op==='tip'?(++number===1?new Promise(resolve=>{release=resolve;}):{status:200,body:{tips:[{title:'Latest report',driveUrl:'https://drive.google.com/drive/folders/latest'}]}}):null});await c.ready;
 const notify=id=>c.events['worker:message']({origin:'https://www.chriscerney.org',data:{type:'cerney-tip-open',url:'https://www.chriscerney.org/tip-alerts/?tip='+id}});
 notify('a'.repeat(64));notify('b'.repeat(64));for(let i=0;i<20;i++)await Promise.resolve();
 release({status:200,body:{tips:[{title:'Old report',driveUrl:'https://drive.google.com/drive/folders/old'}]}});for(let i=0;i<20;i++)await Promise.resolve();
 assert.equal(c.elements.get('selected').children[1].textContent,'Latest report');
});

test('Home Screen launches keep agency reports visible without a notification link',async()=>{
 const report={id:'a'.repeat(64),type:'incident',title:'Soledad report',receivedAt:new Date().toISOString(),driveUrl:'https://drive.google.com/drive/folders/report',instagramDescription:'Complete Instagram caption',voiceover:'Complete recording script',reportState:'needs_review',contextSource:'claude'};
 const newTip={type:'upload',title:'New tip',receivedAt:new Date().toISOString()};
 const respond=()=>({status:200,body:{expiresAt:null,tips:[newTip],reports:[report]}});
 for(let i=0;i<2;i++){
  const c=client({ios:true,respond});await c.ready;
  assert.equal(c.elements.get('reportsSection').hidden,false);assert.equal(cards(c,'reports').length,1);
  const row=cards(c,'reports')[0];assert.equal(row.children[0].children[0].children[1].textContent,'Soledad report');
  assert.equal(row.children[0].children[0].children[0].children[1].textContent,'Needs review');
  assert.equal(row.children.filter(e=>e.className==='report-copy').length,2);
  assert.equal(cards(c,'tips')[0].children[0].children[0].children[1].textContent,'New tip');
  await c.run('loadTips({quiet:true})');assert.equal(cards(c,'reports')[0],row);
  c.run('clearSession()');assert.equal(c.elements.get('reports').children.length,0);assert.equal(c.elements.get('reportsSection').hidden,true);
 }
});

test('a client using the previous API still keeps incident cards in Video reports',async()=>{
 const c=client({respond:()=>({status:200,body:{tips:[{type:'incident',title:'Soledad report',receivedAt:new Date().toISOString(),driveUrl:'https://drive.google.com/drive/folders/report'}]}})});await c.ready;
 assert.equal(cards(c,'reports').length,1);assert.equal(cards(c,'tips').length,0);assert.equal(c.elements.get('empty').hidden,false);
});

test('closing and reopening the Home Screen app reloads the last selected report from the server',async()=>{
 const saved=new Map(),record={id:'a'.repeat(64),type:'incident',title:'Soledad report',receivedAt:new Date().toISOString(),driveUrl:'https://drive.google.com/drive/folders/report',instagramDescription:'Private caption',voiceover:'Private VO'};
 const respond=op=>({status:200,body:{tips:op==='tip'?[record]:[],reports:[record]}});
 const first=client({tip:true,saved,respond});await first.ready;
 assert.equal(saved.get('cerney-open-tip'),record.id);assert.equal(saved.size,1);assert.doesNotMatch(JSON.stringify([...saved]),/Private caption|Private VO|drive.google/);
 const reopened=client({saved,respond,ios:true});await reopened.ready;
 assert.deepEqual(reopened.calls,['list','tip']);assert.equal(reopened.elements.get('selected').children[1].textContent,'Soledad report');
 reopened.run('clearSession()');assert.equal(saved.size,0);assert.equal(reopened.elements.get('selected').children.length,0);
});

test('search and workflow filters retain source separation and never call the network',async()=>{
 const reports=[{id:'a'.repeat(64),type:'incident',receivedAt:new Date().toISOString(),title:'Road closure',agency:'Monterey Fire',reportState:'ready',draftDelivered:true},{id:'b'.repeat(64),type:'incident',receivedAt:new Date().toISOString(),title:'Second story',agency:'Santa Cruz Fire',reportState:'needs_review'}];
 const c=client({respond:()=>({status:200,body:{tips:[],reports}})});await c.ready;const before=c.calls.length;
 c.elements.get('storySearch').value='Monterey';c.elements.get('storySearch').handlers.input();assert.equal(cards(c,'reports').length,1);assert.equal(cards(c,'tips').length,0);
 c.elements.get('chipAttention').handlers.click();assert.equal(cards(c,'reports').length,0);assert.equal(c.elements.get('reportsEmpty').hidden,false);assert.equal(c.calls.length,before);
});
test('saving persists only opaque identifiers; dismissal removes a stale selected story',async()=>{
 const saved=new Map(),id='a'.repeat(64),report={id,type:'incident',receivedAt:new Date().toISOString(),title:'Private title',driveUrl:'https://drive.google.com/drive/folders/test',reportState:'ready',draftDelivered:true};
 const c=client({tip:true,saved,respond:op=>({status:200,body:{tips:op==='tip'?[report]:[],reports:[report]}})});await c.ready;
 const info=cards(c,'reports')[0].children[0].children[0];const actions=info.children.find(x=>x.className==='story-actions');actions.children.at(-1).handlers.click();
 assert.equal(saved.get('cerney-saved-stories'),JSON.stringify([id]));assert.doesNotMatch(JSON.stringify([...saved]),/Private title|drive.google/);
 c.elements.get('selected').children[0].handlers.click();assert.equal(c.elements.get('selected').hidden,true);assert.equal(saved.has('cerney-open-tip'),false);
});

test('stories are grouped by what needs attention first, with status counts that follow the search',async()=>{
 const at=minutes=>new Date(Date.now()-minutes*60000).toISOString();
 const reports=[
  {id:'a'.repeat(64),type:'incident',title:'Older draft',agency:'Monterey Fire',receivedAt:at(90),reportState:'ready',draftDelivered:true},
  {id:'b'.repeat(64),type:'incident',title:'Newer draft',agency:'Santa Cruz Fire',receivedAt:at(10),reportState:'ready',draftDelivered:true},
  {id:'c'.repeat(64),type:'incident',title:'Held story',agency:'Monterey Police',receivedAt:at(30),reportState:'held'},
  {id:'d'.repeat(64),type:'incident',title:'Rendering story',agency:'Salinas Police',receivedAt:at(5),reportState:'rendering'}];
 const c=client({respond:()=>({status:200,body:{tips:[],reports}})});await c.ready;
 const groups=c.elements.get('reports').children;
 assert.deepEqual(groups.map(g=>g.children[0].children[0].textContent),['Needs attention','Draft ready','In progress']);
 assert.deepEqual(groups.map(g=>g.children[0].children[1].textContent),['1','2','1']);
 assert.deepEqual(groups[1].children[1].children.map(card=>card.children[0].children[0].children[1].textContent),['Newer draft','Older draft']);
 assert.deepEqual(['chipAll','chipAttention','chipReady','chipProcessing','chipSaved'].map(id=>c.elements.get(id+'Count').textContent),[4,1,2,1,0]);
 c.elements.get('chipReady').handlers.click();
 assert.deepEqual(c.elements.get('reports').children.map(g=>g.children[0].children[0].textContent),['Draft ready']);
 assert.equal(c.elements.get('chipReady')['aria-pressed'],'true');assert.equal(c.elements.get('chipAll')['aria-pressed'],'false');
 c.elements.get('storySearch').value='Monterey';c.elements.get('storySearch').handlers.input();
 assert.deepEqual(['chipAll','chipAttention','chipReady'].map(id=>c.elements.get(id+'Count').textContent),[2,1,1]);
 assert.equal(cards(c,'reports').length,1);
});

test('long groups show ten stories first and reveal more on request',async()=>{
 const reports=Array.from({length:12},(_,i)=>({id:i.toString(16).padStart(64,'0'),type:'incident',title:'Story '+i,receivedAt:new Date(Date.now()-i*60000).toISOString(),reportState:'ready',draftDelivered:true}));
 const c=client({respond:()=>({status:200,body:{tips:[],reports}})});await c.ready;
 assert.equal(cards(c,'reports').length,10);
 const button=c.elements.get('reports').children[0].children[2];
 assert.match(button.textContent,/Show 2 more · 2 remaining/);
 button.handlers.click();
 assert.equal(cards(c,'reports').length,12);assert.equal(c.elements.get('reports').children[0].children.length,2);
});

test('long summaries start collapsed with a More toggle; short ones have none',async()=>{
 const long='Road closure details. '.repeat(10),short='Brief note.';
 const reports=[{id:'a'.repeat(64),type:'incident',title:'Long',receivedAt:new Date().toISOString(),summary:long,reportState:'ready',draftDelivered:true},
  {id:'b'.repeat(64),type:'incident',title:'Short',receivedAt:new Date(Date.now()-1000).toISOString(),summary:short,reportState:'ready',draftDelivered:true}];
 const c=client({respond:()=>({status:200,body:{tips:[],reports}})});await c.ready;
 const [longInfo,shortInfo]=cards(c,'reports').map(card=>card.children[0].children[0]);
 const toggle=longInfo.children.find(e=>e.className==='text-button summary-toggle');
 assert.equal(toggle.textContent,'More');assert.equal(toggle['aria-expanded'],'false');
 assert.equal(longInfo.children.find(e=>e.className==='tip-summary').textContent,long);
 toggle.handlers.click();assert.equal(toggle.textContent,'Less');assert.equal(toggle['aria-expanded'],'true');
 toggle.handlers.click();assert.equal(toggle.textContent,'More');
 assert.equal(shortInfo.children.some(e=>e.className==='text-button summary-toggle'),false);
});

test('marking a story done moves it to Done, saves only its opaque id and updates the counts',async()=>{
 const saved=new Map(),at=m=>new Date(Date.now()-m*60000).toISOString();
 const reports=[{id:'a'.repeat(64),type:'incident',title:'First draft',receivedAt:at(5),reportState:'ready',draftDelivered:true},
  {id:'b'.repeat(64),type:'incident',title:'Second draft',receivedAt:at(10),reportState:'ready',draftDelivered:true}];
 const c=client({saved,respond:()=>({status:200,body:{tips:[],reports}})});await c.ready;
 const first=cards(c,'reports')[0],actions=first.children[0].children[0].children.find(e=>e.className==='story-actions');
 assert.equal(actions.children.at(-1).className,'save-story');
 const done=actions.children.find(e=>e.className==='mark-done');assert.equal(done.textContent,'Done');
 done.handlers.click();
 assert.equal(saved.get('cerney-done-stories'),JSON.stringify(['a'.repeat(64)]));assert.doesNotMatch(JSON.stringify([...saved]),/First draft|drive.google/);
 assert.deepEqual(c.elements.get('reports').children.map(g=>g.children[0].children[0].textContent),['Draft ready','Done']);
 assert.equal(c.elements.get('readyCount').textContent,1);assert.equal(c.elements.get('chipDoneCount').textContent,1);assert.equal(c.elements.get('chipReadyCount').textContent,1);
 c.elements.get('chipDone').handlers.click();
 assert.deepEqual(cards(c,'reports').map(card=>card.children[0].children[0].children[1].textContent),['First draft']);
 const again=cards(c,'reports')[0].children[0].children[0].children.find(e=>e.className==='story-actions').children.find(e=>e.className==='mark-done');
 assert.equal(again.textContent,'Undo done');again.handlers.click();assert.equal(saved.get('cerney-done-stories'),'[]');
});

test('review mode walks the drafts that need attention newest first, marks them done and finishes',async()=>{
 const at=m=>new Date(Date.now()-m*60000).toISOString();
 const reports=[{id:'a'.repeat(64),type:'incident',title:'Older draft',receivedAt:at(60),reportState:'ready',draftDelivered:true,instagramDescription:'Caption A'},
  {id:'b'.repeat(64),type:'incident',title:'Newest draft',receivedAt:at(5),reportState:'needs_review',instagramDescription:'Caption B',voiceover:'VO B'},
  {id:'c'.repeat(64),type:'incident',title:'Still rendering',receivedAt:at(1),reportState:'rendering',instagramDescription:'Not reviewable yet'}];
 const c=client({respond:()=>({status:200,body:{tips:[],reports}})});await c.ready;
 assert.equal(c.elements.get('reviewStartCount').textContent,2);assert.equal(c.elements.get('reviewStart').hidden,false);
 const title=()=>c.elements.get('reviewStory').children[0].children[0].children[0].children[1].textContent;
 c.elements.get('reviewStart').handlers.click();
 assert.equal(c.elements.get('reviewMode').hidden,false);assert.equal(c.elements.get('reviewProgress').textContent,'Story 1 of 2');assert.equal(title(),'Newest draft');
 assert.equal(c.elements.get('reviewStory').children[0].children.filter(e=>e.className==='report-copy'&&e.open===true).length,2);
 c.elements.get('reviewDone').handlers.click();
 assert.equal(c.elements.get('reviewProgress').textContent,'Story 2 of 2');assert.equal(title(),'Older draft');assert.equal(c.elements.get('reviewStartCount').textContent,1);
 c.elements.get('reviewPrev').handlers.click();assert.equal(title(),'Newest draft');assert.equal(c.elements.get('reviewDone').textContent,'Undo done');
 c.elements.get('reviewNext').handlers.click();c.elements.get('reviewDone').handlers.click();
 assert.equal(c.elements.get('reviewProgress').textContent,'Review complete');assert.equal(c.elements.get('reviewDone').hidden,true);
 c.elements.get('reviewClose').handlers.click();assert.equal(c.elements.get('reviewMode').hidden,true);assert.equal(c.elements.get('reviewStory').children.length,0);
 assert.equal(c.elements.get('reviewStart').hidden,true);
});

test('revoking the device closes review mode and clears its private content',async()=>{
 const report={id:'a'.repeat(64),type:'incident',title:'Private draft',receivedAt:new Date().toISOString(),reportState:'ready',draftDelivered:true,instagramDescription:'Private caption'};
 const c=client({respond:()=>({status:200,body:{tips:[],reports:[report]}})});await c.ready;
 c.elements.get('reviewStart').handlers.click();assert.equal(c.elements.get('reviewStory').children.length,1);
 c.run('clearSession()');
 assert.equal(c.elements.get('reviewMode').hidden,true);assert.equal(c.elements.get('reviewStory').children.length,0);
});
