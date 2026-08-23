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

test('anonymous submissions are sanitized without retaining identifying data', () => {
    const sanitized = helpers.sanitizeSubmission({
        anonymous: true,
        senderName: 'Private Name',
        senderContact: 'private@example.com',
        userAgent: 'identifying browser data',
        description: '  Useful information  ',
    });

    assert.equal(sanitized.senderName, '');
    assert.equal(sanitized.senderContact, '');
    assert.equal(sanitized.userAgent, '');
    assert.equal(sanitized.description, 'Useful information');
});

test('processing validation accepts a complete supported upload', () => {
    const errors = helpers.validateSubmissionForProcessing(
        { fileCount: 1, totalBytes: 42 },
        [{ name: '01_photo.jpg', sizeBytes: 42, mimeType: 'image/jpeg' }]
    );

    assert.deepEqual(errors, []);
});

test('processing validation rejects count, size, and content-type mismatches', () => {
    const errors = helpers.validateSubmissionForProcessing(
        { fileCount: 2, totalBytes: 99 },
        [{ name: '01_payload.svg', sizeBytes: 42, mimeType: 'image/svg+xml' }]
    );

    assert.match(errors.join('\n'), /file count does not match/i);
    assert.match(errors.join('\n'), /byte count does not match/i);
    assert.match(errors.join('\n'), /unsupported file type/i);
});

test('push notifications do not expose submission details or file URLs', () => {
    const notification = helpers.buildPrivacySafeNotification(
        {
            type: 'story_submission',
            senderName: 'Private Name',
            senderContact: 'private@example.com',
            description: 'Sensitive allegation',
        },
        [{ originalName: 'private-document.pdf', url: 'https://example.com/private-token' }],
        [],
        'https://console.firebase.google.com/project/example'
    );
    const serialized = JSON.stringify(notification);

    assert.match(notification.message, /1 file attached/);
    assert.doesNotMatch(serialized, /Private Name|private@example\.com|Sensitive allegation|private-document|private-token/);
});

test('Drive bridge accepts the legacy exact-count success response', () => {
    const files = [{ name: '01_photo.jpg' }, { name: '02_video.mov' }];
    const result = helpers.normalizeDriveBridgeResponse({
        ok: true,
        folderUrl: 'https://drive.google.com/drive/folders/example',
        copied: 2,
    }, files);

    assert.equal(result.complete, true);
    assert.equal(result.copied.length, 2);
    assert.equal(result.copied[0].legacyResponse, true);
});

test('Drive bridge rejects a legacy partial copy', () => {
    const files = [{ name: '01_photo.jpg' }, { name: '02_video.mov' }];
    for (const copied of [1, 3]) {
        assert.throws(
            () => helpers.normalizeDriveBridgeResponse({
                ok: true,
                folderUrl: 'https://drive.google.com/drive/folders/example',
                copied,
            }, files),
            new RegExp(`copied ${copied} of 2 files`)
        );
    }
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
