const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

process.env.GCLOUD_PROJECT = 'tip-line-8c2d7';
process.env.FIREBASE_CONFIG = JSON.stringify({
    projectId: 'tip-line-8c2d7',
    storageBucket: 'tip-line-8c2d7.firebasestorage.app',
});

const helpers = require('./tipline-helpers');

test('manifest map preserves unique stored names', () => {
    const manifest = helpers.buildManifestMap({
        files: [
            { name: 'clip.mov', storedName: '01_clip.mov', size: 10 },
            { name: 'clip.mov', storedName: '02_clip.mov', size: 20 },
        ],
    });

    assert.equal(manifest.size, 2);
    assert.equal(manifest.get('01_clip.mov').size, 10);
    assert.equal(manifest.get('02_clip.mov').size, 20);
});

test('submission validation accepts a complete upload', () => {
    const warnings = helpers.validateSubmission(
        {
            fileCount: 2,
            totalBytes: 30,
            files: [
                { name: 'a.jpg', storedName: '01_a.jpg' },
                { name: 'b.mov', storedName: '02_b.mov' },
            ],
        },
        [
            { name: '01_a.jpg', sizeBytes: 10 },
            { name: '02_b.mov', sizeBytes: 20 },
        ]
    );

    assert.deepEqual(warnings, []);
});

test('submission validation reports missing or overwritten files', () => {
    const warnings = helpers.validateSubmission(
        {
            fileCount: 2,
            totalBytes: 30,
            files: [
                { name: 'clip.mov', storedName: '01_clip.mov' },
                { name: 'clip.mov', storedName: '02_clip.mov' },
            ],
        },
        [{ name: '01_clip.mov', sizeBytes: 10 }]
    );

    assert.equal(warnings.length, 3);
    assert.match(warnings.join('\n'), /Storage is missing manifest file "02_clip\.mov"/);
});

test('download token parser ignores empty token entries', () => {
    assert.equal(helpers.firstDownloadToken(' , token-123, token-456'), 'token-123');
    assert.equal(helpers.firstDownloadToken(''), null);
});

test('Drive bridge honors the server Range offset for resumable uploads', () => {
    const context = {
        console,
        Utilities: {},
    };
    vm.createContext(context);
    const bridge = fs.readFileSync(
        path.join(__dirname, '..', 'upload', 'drive-bridge-apps-script.gs'),
        'utf8'
    );
    vm.runInContext(bridge, context);

    assert.equal(context.rangeNextOffset_('bytes=0-16777215'), 16777216);
    assert.equal(context.rangeNextOffset_(null), 0);

    const response = {
        getResponseCode: () => 308,
        getAllHeaders: () => ({ Range: 'bytes=0-33554431' }),
        getContentText: () => '',
    };
    assert.deepEqual(
        JSON.parse(JSON.stringify(context.parseUploadResponse_(response, 100000000))),
        {
            ok: true,
            complete: false,
            nextOffset: 33554432,
        }
    );
});
