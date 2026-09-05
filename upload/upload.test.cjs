const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function client({ failManifest = false } = {}) {
    const elements = new Map();
    const element = () => ({
        handlers: {}, style: {}, value: '', checked: true,
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(name, callback) { this.handlers[name] = callback; },
        replaceChildren() {}, append() {}, appendChild() {}, setAttribute() {}, focus() {},
        dataset: {}, querySelector: () => element(),
    });
    const uploads = [];
    const manifests = [];
    const context = vm.createContext({
        document: {
            getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
            createElement: element,
        },
        window: { addEventListener() {}, scrollTo() {} }, navigator: { userAgent: 'test' },
        crypto: require('node:crypto').webcrypto, Blob, setTimeout, alert() {},
        console: { error() {} }, initializeApp() {}, getStorage() {}, ref: (_, path) => path,
        uploadBytesResumable(path) {
            uploads.push(path);
            return { cancel() {}, on(_, progress, error, done) { queueMicrotask(done); } };
        },
        async uploadBytes(path, blob, metadata) {
            manifests.push({ path, metadata });
            if (failManifest) { failManifest = false; throw new Error('storage/unauthorized'); }
        },
    });
    const source = fs.readFileSync(__dirname + '/upload.js', 'utf8').replace(/import[\s\S]*?from "[^"]+";/g, '');
    vm.runInContext(source, context);
    return {
        uploads, manifests, elements,
        add: file => vm.runInContext(`addFiles([${JSON.stringify(file)}])`, context),
        submit: () => elements.get('submitBtn').handlers.click(),
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
