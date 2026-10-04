const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function client({ failManifest = false, failContext = false } = {}) {
    const elements = new Map();
    const element = () => ({
        handlers: {}, style: {}, value: '', checked: false, open: false,
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(name, callback) { this.handlers[name] = callback; },
        replaceChildren() {}, append() {}, appendChild() {}, setAttribute() {}, focus() {},
        dataset: {}, querySelector: () => element(),
        showModal() { this.open = true; }, close() { this.open = false; },
        reset() {}, setCustomValidity() {}, reportValidity() { return true; },
    });
    const uploads = [];
    const manifests = [];
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
            return { cancel() {}, on(_, progress, error, done) { queueMicrotask(done); } };
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
        uploads, manifests, elements,
        add: file => vm.runInContext(`addFiles([${JSON.stringify(file)}])`, context),
        start: () => elements.get('submitBtn').handlers.click(),
        flush,
        submit: async () => {
            const run = elements.get('submitBtn').handlers.click();
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

test('double clicking submit does not start a second upload', async () => {
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
