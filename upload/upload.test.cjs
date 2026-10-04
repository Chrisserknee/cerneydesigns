const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function client({ failManifest = false, failContext = false, holdUploads = false } = {}) {
    const elements = new Map();
    const element = () => ({
        handlers: {}, style: {}, value: '', checked: false, open: false, children: [],
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(name, callback) { this.handlers[name] = callback; },
        replaceChildren() { this.children=[]; }, append(...children) {this.children.push(...children);}, appendChild(child) {this.children.push(child);}, setAttribute() {}, focus() {},
        dataset: {}, querySelector: () => element(),
        showModal() { this.open = true; }, close() { this.open = false; },
        reset() {}, setCustomValidity() {}, reportValidity() { return true; },
    });
    const uploads = [];
    const manifests = [];
    const tasks = [];
    const context = vm.createContext({
        document: {
            body: element(),
            getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
            createElement: element,
        },
        window: { addEventListener() {}, scrollTo() {} }, navigator: { userAgent: 'test' },
        crypto: require('node:crypto').webcrypto, TextEncoder, Blob, setTimeout, alert() {},
        console: { error() {} }, initializeApp() {}, getStorage() {}, ref: (_, path) => path,
        uploadBytesResumable(path, file, metadata) {
            uploads.push({ path, metadata });
            return { cancel() {}, on(_, progress, error, done) { tasks.push({progress,error,done}); if(!holdUploads) queueMicrotask(done); } };
        },
        async uploadBytes(path, blob, metadata) {
            manifests.push({ path, metadata, data: JSON.parse(await blob.text()) });
            if ((failManifest && path.endsWith('/_submission.json')) || (failContext && path.endsWith('/_context.json'))) { failManifest = false; failContext = false; throw new Error('storage/unknown'); }
        },
    });
    const source = fs.readFileSync(__dirname + '/upload.js', 'utf8').replace(/import[\s\S]*?from "[^"]+";/g, '');
    vm.runInContext(source, context);
    const flush = async () => { for(let i=0;i<100;i++) { if(elements.get('detailsDialog').open || elements.get('errorScreen').hidden===false || elements.get('thankyouScreen').hidden===false) break; await new Promise(resolve => setTimeout(resolve,2)); } };
    return {
        uploads, manifests, elements, tasks,
        choose: files => elements.get('fileInput').handlers.change({target:{files}}),
        drop: files => elements.get('dropzone').handlers.drop({preventDefault(){},dataTransfer:{files}}),
        add: file => vm.runInContext(`addFiles([${JSON.stringify(file)}])`, context),
        start: () => vm.runInContext('startUpload()', context),
        flush,
        submit: async () => {
            const run = vm.runInContext('startUpload()', context);
            await flush();
            if (elements.get('detailsDialog').open) elements.get('skipDetails').handlers.click();
            return run;
        },
    };
}

test('final manifest supplies metadata required by storage rules', async () => {
    const c = client();
    c.add({ name: 'photo.jpg', size: 100, type: 'image/jpeg' });
    await c.submit();
    assert.equal(c.manifests[0].metadata.customMetadata.anonymous, 'true');
    assert.equal(c.elements.get('thankyouScreen').hidden, false);
});

test('retrying finalization keeps completed media and the original session', async () => {
    const c = client({ failManifest: true });
    c.add({ name: 'video.mov', size: 100, type: 'video/quicktime' });
    await c.submit();
    assert.match(c.elements.get('errorBody').textContent, /completed files will not upload again/);
    await c.submit();
    assert.equal(c.uploads.length, 1);
    assert.equal(c.manifests[0].path, c.manifests[1].path);
    assert.equal(c.elements.get('thankyouScreen').hidden, false);
});

test('duplicate start calls do not start a second upload', async () => {
    const c = client();
    c.add({ name: 'photo.jpg', size: 100, type: 'image/jpeg' });
    await Promise.all([c.submit(), c.submit()]);
    assert.equal(c.uploads.length, 1);
    assert.equal(c.manifests.length, 1);
});

test('empty files cannot produce a rejected backend submission', async () => {
    const c = client();
    c.add({ name: 'photo.jpg', size: 0, type: 'image/jpeg' });
    await c.submit();
    assert.equal(c.uploads.length, 0);
});

test('supported file extension is accepted when the browser omits MIME type', async () => {
    const c = client(); c.add({ name: 'photo.AVIF', type: '', size: 100 }); await c.submit();
    assert.equal(c.uploads.length, 1); assert.equal(c.manifests.length, 1);
});


test('media tip is committed BEFORE the optional popup, even if the sender never completes it', async () => {
    const c = client(); c.add({ name: 'photo.jpg', size: 100, type: 'image/jpeg' });
    const run = c.start(); await c.flush();
    assert.equal(c.uploads.length, 1);
    assert.equal(c.manifests.length, 1);
    assert.equal(c.manifests[0].data.detailsStatus, 'pending');
    assert.match(c.manifests[0].data.contextKeyHash,/^[a-f0-9]{64}$/);
    assert.equal('contextToken' in c.manifests[0].data,false);
    assert.equal(c.elements.get('detailsDialog').open, true);
    assert.equal(c.elements.get('thankyouScreen').hidden, true);
    c.elements.get('skipDetails').handlers.click(); await run;
    assert.equal(c.manifests[0].data.anonymous, true);
    assert.equal(c.manifests[0].data.nameUsageConsent, 'anonymous');
    assert.equal(c.manifests[0].data.detailsStatus, 'pending');
    assert.equal(c.manifests.length,1);
});

test('explicit name permission and separate what/when/where fields attach to the same tip folder without changing its media manifest', async () => {
    const c = client(); c.add({ name: 'photo.jpg', size: 100, type: 'image/jpeg' });
    const run = c.start(); await c.flush();
    const get = id => c.elements.get(id);
    get('whatHappened').value = 'A tree fell across the road.';
    get('timing').value = 'Today around 3 PM'; get('location').value = 'Test intersection';
    get('detailsForm').handlers.submit({ preventDefault() {} });
    assert.equal(get('identityForm').hidden, false);
    assert.equal(get('detailsForm').hidden, true);
    get('useName').checked = true; get('useName').handlers.change();
    get('senderName').value = ' Test Contributor '; get('senderContact').value = 'example@example.com';
    get('identityForm').handlers.submit({ preventDefault() {} }); await run;
    const data = c.manifests[1].data;
    assert.equal(c.manifests[1].path.replace('_context.json','_submission.json'),c.manifests[0].path);
    assert.equal(require('node:crypto').createHash('sha256').update(data.contextToken).digest('hex'),c.manifests[0].data.contextKeyHash);
    assert.equal(data.whatHappened, 'A tree fell across the road.');
    assert.equal(data.location, 'Test intersection'); assert.equal(data.timing, 'Today around 3 PM');
    assert.equal('files' in data,false);
    assert.equal(data.senderName, 'Test Contributor');
    assert.equal(data.anonymous, false); assert.equal(data.nameUsageConsent, 'use_name');
    assert.equal(JSON.stringify(c.uploads[0].metadata.customMetadata), JSON.stringify({ anonymous: 'true' }));
});

test('changing to anonymous removes name/contact but preserves the story details', async () => {
    const c = client(); c.add({ name: 'photo.jpg', size: 100, type: 'image/jpeg' });
    const run = c.start(); await c.flush(); const get = id => c.elements.get(id);
    get('whatHappened').value = 'Preserve this context';
    get('useName').checked = true; get('senderName').value = 'Private name'; get('senderContact').value = 'Private phone';
    get('useName').checked = false; get('keepAnonymous').checked = true; get('keepAnonymous').handlers.change();
    assert.equal(get('senderName').value, ''); assert.equal(get('senderContact').value, '');
    get('identityForm').handlers.submit({ preventDefault() {} }); await run;
    const data = c.manifests[1].data;
    assert.equal(c.manifests[1].path.replace('_context.json','_submission.json'),c.manifests[0].path);
    assert.equal(require('node:crypto').createHash('sha256').update(data.contextToken).digest('hex'),c.manifests[0].data.contextKeyHash);
    assert.equal(data.anonymous, true); assert.equal(data.whatHappened, 'Preserve this context');
    for (const key of ['senderName', 'senderContact', 'userAgent']) assert.equal(key in data, false);
});

test('Escape finalizes anonymously instead of leaving uploaded media unsubmitted', async () => {
    const c = client(); c.add({ name: 'photo.jpg', size: 100, type: 'image/jpeg' });
    const run = c.start(); await c.flush();
    c.elements.get('senderName').value = 'Must not be sent'; c.elements.get('useName').checked = true;
    c.elements.get('detailsDialog').handlers.cancel({ preventDefault() {} }); await run;
    assert.equal(c.manifests.length, 1); assert.equal(c.manifests[0].data.anonymous, true);
    assert.equal('senderName' in c.manifests[0].data, false);
});

test('failed optional context retry retains details and never resends media or initial manifest', async () => {
    const c = client({ failContext: true }); c.add({ name: 'photo.jpg', size: 100, type: 'image/jpeg' });
    const run = c.start(); await c.flush();
    c.elements.get('whatHappened').value = 'Do not lose this';
    c.elements.get('keepAnonymous').checked = true;
    c.elements.get('identityForm').handlers.submit({ preventDefault() {} }); await run;
    await c.start();
    assert.equal(c.uploads.length, 1); assert.equal(c.manifests.length, 3);
    assert.equal(c.manifests[1].data.whatHappened, 'Do not lose this');
    assert.equal(c.manifests[2].path, c.manifests[1].path);
    assert.equal(c.manifests.filter(m=>m.path.endsWith('/_submission.json')).length,1);
    assert.equal(c.elements.get('detailsDialog').open, false);
});

const wait = () => new Promise(resolve => setTimeout(resolve, 12));
test('choosing five large videos starts automatically, yields first, and streams only two at a time', async () => {
    const c = client({holdUploads:true});
    const files = Array.from({length:5}, (_,i) => ({name:`clip-${i+1}.mov`,size:100*1024*1024,type:'video/quicktime',lastModified:i,
        arrayBuffer(){throw Error('Do not read entire videos during selection');},stream(){throw Error('Do not preload videos during selection');}}));
    c.choose(files);
    assert.equal(c.uploads.length,0,'picker change returns before starting streams');
    await wait();
    assert.equal(c.elements.get('progressScreen').hidden,false);
    assert.equal(c.elements.get('fileList').children.length,5);
    assert.equal(c.elements.get('progressFile').textContent,'0 of 5 files complete');
    assert.equal(c.uploads.length,2);
    c.choose(files);c.drop(files);await wait();assert.equal(c.uploads.length,2,'duplicate selection cannot restart active batch');
    c.tasks[0].progress({bytesTransferred:50*1024*1024});
    assert.match(c.elements.get('fileList').children[0].children[2].textContent,/50%/);
    c.tasks[0].done();await wait();assert.equal(c.uploads.length,3);assert.equal(c.manifests.length,0);
    c.tasks[1].done();await wait();assert.equal(c.uploads.length,4);
    c.tasks[2].done();await wait();assert.equal(c.uploads.length,5);
    c.tasks[3].done();c.tasks[4].done();await c.flush();
    assert.equal(c.manifests.length,1);assert.equal(c.manifests[0].data.fileCount,5);assert.equal(c.manifests[0].data.totalBytes,500*1024*1024);
    assert.equal(c.elements.get('progressPercent').textContent,'100%');
    c.elements.get('skipDetails').handlers.click();await wait();assert.equal(c.elements.get('thankyouScreen').hidden,false);
});
test('cancelled picker does not upload and drag-and-drop also starts automatically', async () => {
    const c=client();c.choose([]);await wait();assert.equal(c.uploads.length,0);
    c.drop([{name:'drop.jpg',size:100,type:'image/jpeg'}]);await c.flush();
    assert.equal(c.uploads.length,1);assert.equal(c.manifests.length,1);c.elements.get('skipDetails').handlers.click();await wait();
});
test('invalid batch is explained inline and never silently uploads only some selected videos', async () => {
    const c=client();c.choose([{name:'valid.mov',size:100,type:'video/quicktime'},{name:'large.mov',size:501*1024*1024,type:'video/quicktime'}]);await wait();
    assert.equal(c.uploads.length,0);assert.equal(c.elements.get('selectionNotice').hidden,false);assert.match(c.elements.get('selectionNotice').textContent,/Nothing has been sent.*[\s\S]*large.mov/);
    c.choose([{name:'valid.mov',size:100,type:'video/quicktime'}]);await c.flush();assert.equal(c.uploads.length,1);assert.equal(c.elements.get('selectionNotice').hidden,true);c.elements.get('skipDetails').handlers.click();await wait();
});
test('retry button resumes automatically in one tap without resending completed media', async () => {
    const c=client({failContext:true});c.choose([{name:'video.mov',size:100,type:'video/quicktime'}]);await c.flush();
    c.elements.get('whatHappened').value='Keep these details';c.elements.get('identityForm').handlers.submit({preventDefault(){}});await wait();
    assert.equal(c.elements.get('errorScreen').hidden,false);c.elements.get('errorRetry').handlers.click();await wait();
    assert.equal(c.uploads.length,1);assert.equal(c.manifests.filter(x=>x.path.endsWith('_submission.json')).length,1);assert.equal(c.elements.get('thankyouScreen').hidden,false);
});
