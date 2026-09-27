const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function client() {
    const elements = new Map(), uploads = [], manifests = [];
    let failManifest = true;
    const element = () => ({ handlers: {}, value: '', style: {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {} },
        addEventListener(name, fn) { this.handlers[name] = fn; }, querySelector() { return { value: 'Yes' }; }, querySelectorAll: () => [],
        replaceChildren() {}, append() {}, appendChild() {}, setAttribute() {}, focus() {}, reset() {} });
    const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
    const context = vm.createContext({
        document: { getElementById: get, querySelectorAll: () => [element()], querySelector: get, createElement: element },
        window: { addEventListener() {}, scrollTo() {} }, navigator: { userAgent: 'test' },
        crypto: require('node:crypto').webcrypto, Blob, setTimeout, console: { error() {} },
        initializeApp() {}, getStorage() {}, ref: (_, path) => path,
        uploadBytesResumable(path) { uploads.push(path); return { cancel() {}, on(_, progress, error, done) { queueMicrotask(done); } }; },
        async uploadBytes(path, blob) { manifests.push({ path, body: JSON.parse(await blob.text()) }); if (failManifest) { failManifest = false; throw new Error('network'); } },
    });
    vm.runInContext(fs.readFileSync(__dirname + '/submit-story.js', 'utf8').replace(/import[\s\S]*?from "[^"]+";/g, ''), context);
    return { uploads, manifests, elements, add: file => vm.runInContext(`addFiles([${JSON.stringify(file)}])`, context), submit: () => vm.runInContext('submitStoryIdea()', context) };
}
test('story retry preserves completed media and finalizes the original submission', async () => {
    const c = client(); c.add({ name: 'video.mov', size: 100, type: 'video/quicktime' });
    await c.submit(); assert.match(c.elements.get('formError').textContent, /will not upload again/);
    await c.submit(); assert.equal(c.uploads.length, 1); assert.equal(c.manifests[0].path, c.manifests[1].path);
    assert.equal(c.manifests[1].body.fileCount, 1); assert.equal(c.manifests[1].body.totalBytes, 100);
    assert.equal(c.elements.get('successScreen').hidden, false);
});
test('empty story media is excluded from the manifest', async () => {
    const c = client(); c.add({ name: 'empty.mov', size: 0, type: 'video/quicktime' }); await c.submit();
    assert.equal(c.uploads.length, 0); assert.equal(c.manifests[0].body.fileCount, 0);
});
