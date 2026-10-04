const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function client() {
    const elements = new Map(), uploads = [], manifests = [];
    let failManifest = true;
    const element = () => ({ handlers: {}, value: '', style: {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {} },
        addEventListener(name, fn) { this.handlers[name] = fn; }, querySelector() { return { value: 'Yes' }; }, querySelectorAll: () => [],
        replaceChildren() {}, append() {}, appendChild() {}, setAttribute() {}, focus() {}, reset() {}, click() { return this.handlers.click?.(); } });
    const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
    const steps = Array.from({ length: 7 }, element);
    const context = vm.createContext({
        document: { getElementById: get, querySelectorAll: () => steps, querySelector: get, createElement: element },
        window: { addEventListener() {}, scrollTo() {} }, navigator: { userAgent: 'test' },
        crypto: require('node:crypto').webcrypto, Blob, setTimeout, console: { error() {} },
        initializeApp() {}, async authorizeUpload() {}, getStorage() {}, ref: (_, path) => path,
        uploadBytesResumable(path) { uploads.push(path); return { cancel() {}, on(_, progress, error, done) { queueMicrotask(done); } }; },
        async uploadBytes(path, blob) { manifests.push({ path, body: JSON.parse(await blob.text()) }); if (failManifest) { failManifest = false; throw new Error('network'); } },
    });
    vm.runInContext(fs.readFileSync(__dirname + '/submit-story.js', 'utf8').replace(/import[\s\S]*?from "[^"]+";/g, ''), context);
    return { uploads, manifests, elements, steps, run: source => vm.runInContext(source, context), add: file => vm.runInContext(`addFiles([${JSON.stringify(file)}])`, context), submit: () => vm.runInContext('submitStoryIdea()', context) };
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

test('Enter on an early wizard step advances without submitting', async () => {
    const c = client();
    await c.elements.get('storyIdeaForm').handlers.submit({ preventDefault() {} });
    assert.equal(c.run('currentStep'), 1);
    assert.equal(c.manifests.length, 0);
    assert.equal(c.uploads.length, 0);
});
test('final review revalidates earlier required answers', async () => {
    const c = client();
    c.steps[0].querySelectorAll = () => [{ type: 'textarea', value: '', focus() {} }];
    c.run('showStep(6)');
    await c.elements.get('storyIdeaForm').handlers.submit({ preventDefault() {} });
    assert.equal(c.run('currentStep'), 0);
    assert.equal(c.manifests.length, 0);
    assert.match(c.elements.get('formError').textContent, /Fill this out/);
});
test('upload in progress cannot navigate to a different step', () => {
    const c = client(); c.run('showStep(6); isSubmitting = true');
    c.elements.get('prevBtn').handlers.click();
    assert.equal(c.run('currentStep'), 6);
});
test('anonymous coverage preserves explicitly offered private follow-up in the manifest', () => {
    const c = client();
    c.elements.get('senderName').value = 'Test source';
    c.elements.get('senderContact').value = 'source@example.invalid';
    const data = c.run('collectData()');
    assert.equal(data.anonymous, true);
    assert.equal(data.canContact, 'Yes');
    assert.equal(data.senderName, 'Test source');
    assert.equal(data.senderContact, 'source@example.invalid');
    assert.equal(data.userAgent, '');
});
test('supported story video without browser MIME information is accepted', async () => {
    const c = client(); c.add({ name: 'clip.webm', type: '', size: 100 }); await c.submit();
    assert.equal(c.uploads.length, 1);
    assert.equal(c.manifests[0].body.files[0].type, 'video/webm');
});
