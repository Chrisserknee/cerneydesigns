// ============================================================
// TIPLINE — verified Google Drive delivery
// Triggers when tips/*/_submission.json is finalized after all
// media is in Storage, then reliably mirrors it to Google Drive.
// ============================================================
const { randomUUID, createHash } = require('node:crypto');
const { transferToDrive } = require('./drive-transfer');
const { onObjectFinalized } = require('firebase-functions/v2/storage');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { GoogleAuth } = require('google-auth-library');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getStorage } = require('firebase-admin/storage');
const {
    buildManifestMap,
    firstDownloadToken,
    normalizeDriveBridgeResponse,
    sanitizeSubmission,
    validateSubmission,
    validateSubmissionForProcessing,
} = require('./tipline-helpers');

initializeApp();

const driveBridgeUrl = defineSecret('DRIVE_BRIDGE_URL');
const driveBridgeToken = defineSecret('DRIVE_BRIDGE_TOKEN');
const driveAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive.readonly'] });

async function processTip(event) {
        const object = event.data;
        const filePath = object.name;

        if (!filePath || !filePath.startsWith('tips/') || !filePath.endsWith('/_submission.json')) {
            return null;
        }

        const folder = filePath.substring(0, filePath.lastIndexOf('/'));
        const bucket = getStorage().bucket(object.bucket);
        const submissionFile = bucket.file(filePath);
        const sessionLabel = folder.split('/').pop() || 'tip';
        const deliveryId = event.id || `${object.bucket}:${filePath}:${object.generation || 'unknown'}`;

        let submission;
        try {
            const [buf] = await submissionFile.download();
            await revokeDownloadTokens([submissionFile]);
            const parsedSubmission = JSON.parse(buf.toString('utf8'));
            if (!parsedSubmission || typeof parsedSubmission !== 'object' || Array.isArray(parsedSubmission)) {
                logger.error(`Rejected malformed submission manifest for ${folder}`);
                await mergeWorkflowMetadata(submissionFile, { processingStatus: 'rejected' });
                return null;
            }
            submission = sanitizeSubmission(parsedSubmission);
        } catch (err) {
            logger.error('Failed to read submission JSON', err);
            if (err instanceof SyntaxError) {
                await mergeWorkflowMetadata(submissionFile, { processingStatus: 'rejected' });
                return null;
            }
            throw err;
        }

        const [files] = await bucket.getFiles({ prefix: folder + '/' });
        const tipFiles = files.filter((file) => !file.name.endsWith('/_submission.json'));
        const fileMetadata = tipFiles.map(fileMetadataForValidation);
        const processingErrors = validateSubmissionForProcessing(submission, fileMetadata);
        if (processingErrors.length) {
            logger.error(`Rejected invalid submission for ${folder}`, { processingErrors });
            await mergeWorkflowMetadata(submissionFile, { processingStatus: 'rejected' });
            return null;
        }
        const integrityWarnings = validateSubmission(submission, fileMetadata);
        if (integrityWarnings.length) {
            logger.error(`Rejected submission with an integrity mismatch for ${folder}`, { integrityWarnings });
            await mergeWorkflowMetadata(submissionFile, { processingStatus: 'rejected' });
            return null;
        }
        const manifestByStoredName = buildManifestMap(submission);
        let workflow = await getWorkflowMetadata(submissionFile);
        const fileLinks = await Promise.all(
            tipFiles.map((file) => buildFileLink(file, object.bucket, manifestByStoredName, workflow.driveCopyStatus !== 'complete'))
        );

        let driveFolderUrl = workflow.driveFolderUrl || null;
        const driveFiles = fileLinks.length ? fileLinks
            : submission.type === 'story_submission' ? [buildStoryDocument(submission, object.bucket, folder)] : [];

        if (driveFiles.length && workflow.driveCopyStatus !== 'complete') {
            try {
                const driveMirror = await mirrorSessionToDriveBridge({
                    deliveryId,
                    bucket,
                    sessionLabel,
                    files: driveFiles,
                    onMediaReady: async (folderUrl) => {
                        // Publish only after an independent size/checksum check. The
                        // photo can open while the bridge writes its summary files.
                        workflow = await mergeWorkflowMetadata(submissionFile, {
                            driveCopyStatus: 'finalizing', driveFolderUrl: folderUrl,
                            driveMediaReadyAt: new Date().toISOString(),
                        });
                        logger.info('Tip media ready in Drive', {elapsedMs:Date.now()-Date.parse(object.timeCreated)});
                    },
                    submission: {
                        ...submission,
                        deliveryAudit: {
                            actualFileCount: fileLinks.length,
                            actualTotalBytes: fileLinks.reduce((sum, file) => sum + file.sizeBytes, 0),
                            warnings: integrityWarnings,
                        },
                    },
                });
                driveFolderUrl = driveMirror.folderUrl;
                workflow = await mergeWorkflowMetadata(submissionFile, {
                    driveCopyStatus: 'complete',
                    driveFolderUrl,
                    driveCompletedAt: new Date().toISOString(),
                    driveDeliveryId: deliveryId,
                    driveVerification: 'size-and-md5',
                });
                logger.info(`Drive mirror verified for ${folder}`, {
                    copied: driveMirror.copied.length,
                });
                await revokeDownloadTokens(tipFiles);
            } catch (err) {
                logger.error('Drive mirror failed; Eventarc will retry', err);
                await mergeWorkflowMetadata(submissionFile, {
                    driveLastFailureAt: new Date().toISOString(),
                });
                throw err;
            }
        } else if (workflow.driveCopyStatus === 'complete') {
            logger.info(`Drive mirror already complete for ${folder}; skipping duplicate copy`);
            await revokeDownloadTokens(tipFiles);
        }

        return null;
}

const deliveryOptions = {
    region: 'us-west1',
    secrets: [driveBridgeUrl, driveBridgeToken],
    memory: '1GiB',
    concurrency: 4,
    maxInstances: 3,
    timeoutSeconds: 540,
};
exports.notifyOnTip = onObjectFinalized({ ...deliveryOptions, retry: true }, processTip);

exports.retryTipDeliveries = onSchedule({
    ...deliveryOptions,
    schedule: 'every 5 minutes',
    maxInstances: 1,
}, async () => {
    const started = Date.now();
    const bucket = getStorage().bucket();
    const [files] = await bucket.getFiles({ prefix: 'tips/' });
    const mediaFolders = new Set(files.filter(file => !file.name.endsWith('/_submission.json'))
        .map(file => file.name.slice(0, file.name.lastIndexOf('/'))));
    const pending = files.filter(file => {
        const metadata = file.metadata || {};
        const state = metadata.metadata || {};
        const age = started - Date.parse(metadata.timeCreated);
        return file.name.endsWith('/_submission.json')
            && state.processingStatus !== 'rejected'
            && age > 5 * 60 * 1000 && age < 30 * 24 * 60 * 60 * 1000
            && state.driveCopyStatus !== 'complete'
            && (mediaFolders.has(file.name.slice(0, file.name.lastIndexOf('/'))) || file.name.startsWith('tips/submit-story_'));
    }).sort((a, b) => Date.parse(a.metadata.metadata?.driveLastFailureAt || a.metadata.timeCreated)
        - Date.parse(b.metadata.metadata?.driveLastFailureAt || b.metadata.timeCreated));
    for (const file of pending) {
        if (Date.now() - started > 420000) break;
        try {
            await processTip({ data: { ...file.metadata, bucket: bucket.name }, id: `reconcile:${file.metadata.generation}` });
        } catch (error) {
            logger.error('Scheduled tip delivery still pending', { path: file.name, message: error.message });
        }
    }
});

// Text-only story submissions still need a Drive folder and readable details.
function buildStoryDocument(submission, bucketName, folder) {
    const inlineBytes = Buffer.from(JSON.stringify(submission, null, 2));
    return {
        name: '01_STORY_DETAILS.json', originalName: 'Story details',
        sizeBytes: inlineBytes.length, mimeType: 'application/json',
        md5Hash: createHash('md5').update(inlineBytes).digest('base64'), inlineBytes,
        // Private, token-free source reference. Bytes are transferred directly;
        // the bridge only verifies the completed Drive file at finalization.
        url: `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(folder + '/_submission.json')}?alt=media`,
    };
}

async function verifyDriveContents(folderUrl, files) {
    const folderId = new URL(folderUrl).pathname.split('/').pop();
    if (!/^[A-Za-z0-9_-]+$/.test(folderId)) throw new Error('Invalid Drive destination');
    const client = await driveAuth.getClient();
    const found = [];
    let pageToken;
    do {
        const { data } = await client.request({
            url: 'https://www.googleapis.com/drive/v3/files',
            params: { q: `'${folderId}' in parents and trashed = false`, fields: 'nextPageToken,files(id,name,size,md5Checksum)', pageSize: 100, pageToken },
            timeout: 30000,
        });
        found.push(...(data.files || []));
        pageToken = data.nextPageToken;
    } while (pageToken);
    for (const source of files) {
        const checksum = Buffer.from(source.md5Hash, 'base64').toString('hex');
        if (!checksum || !found.some(file => file.name === source.name
            && Number(file.size) === source.sizeBytes && file.md5Checksum === checksum)) {
            throw new Error(`Drive file verification failed for ${source.name}`);
        }
    }
}

async function buildFileLink(file, bucketName, manifestByStoredName, needsDownload = true) {
    let metadata = file.metadata || {};
    let customMetadata = metadata.metadata || {};
    let token = firstDownloadToken(customMetadata.firebaseStorageDownloadTokens);

    if (!token && needsDownload) {
        token = randomUUID();
        [metadata] = await file.setMetadata({
            metadata: {
                ...customMetadata,
                firebaseStorageDownloadTokens: token,
            },
        });
        customMetadata = metadata.metadata || {};
        logger.info(`Created missing download token for ${file.name}`);
    }

    const basename = file.name.split('/').pop();
    const manifestFile = manifestByStoredName.get(basename);
    return {
        name: basename,
        originalName: manifestFile?.name || basename,
        sourcePath: file.name,
        generation: String(metadata.generation || ''),
        md5Hash: metadata.md5Hash || '',
        url: `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(file.name)}?alt=media&token=${token}`,
        sizeBytes: Number(metadata.size || 0),
        mimeType: metadata.contentType || 'application/octet-stream',
    };
}

function fileMetadataForValidation(file) {
    const metadata = file.metadata || {};
    return {
        name: file.name.split('/').pop(),
        sizeBytes: Number(metadata.size || 0),
        mimeType: metadata.contentType || 'application/octet-stream',
    };
}

async function revokeDownloadTokens(files) {
    await Promise.all(files.map(async (file) => {
        const [metadata] = await file.getMetadata();
        const customMetadata = { ...(metadata.metadata || {}) };
        if (!customMetadata.firebaseStorageDownloadTokens) return;
        // GCS PATCH requires explicit null to remove a custom metadata key.
        customMetadata.firebaseStorageDownloadTokens = null;
        await file.setMetadata({ metadata: customMetadata });
    }));
}

async function getWorkflowMetadata(file) {
    const [metadata] = await file.getMetadata();
    return metadata.metadata || {};
}

async function mergeWorkflowMetadata(file, updates) {
    const [metadata] = await file.getMetadata();
    const [updated] = await file.setMetadata({
        metadata: {
            ...(metadata.metadata || {}),
            ...Object.fromEntries(
                Object.entries(updates).map(([key, value]) => [key, String(value)])
            ),
        },
    });
    return updated.metadata || {};
}

/**
 * Calls the Apps Script bridge. The bridge runs as Chris's Google account,
 * which avoids the personal-Drive quota issue service accounts hit.
 */
async function mirrorSessionToDriveBridge({ deliveryId, bucket, sessionLabel, files, submission, onMediaReady }) {
    const url = driveBridgeUrl.value();
    if (!isApprovedDriveBridgeUrl(url)) throw new Error('DRIVE_BRIDGE_URL is not configured.');
    const leaseId = randomUUID();
    const deadline = Date.now() + 420000;
    const callBridge = async (action) => {
        const res = await fetch(url, {
            method: 'POST', signal: AbortSignal.timeout(action === 'release' ? 5000 : 60000),
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ token: driveBridgeToken.value(), deliveryId, leaseId, action, sessionLabel, submission, files: files.map(({ inlineBytes, ...file }) => file) }),
        });
        let payload;
        try { payload = await res.json(); } catch { throw new Error('Drive bridge returned an invalid response.'); }
        if (!res.ok || !payload.ok) throw new Error(String(payload.error || `Drive bridge HTTP ${res.status}`).replace(/https?:\/\/\S+/g, '[URL]'));
        return payload;
    };
    let leased = false;
    try {
        const prepared = await callBridge('prepare');
        if (prepared.transferMode !== 'direct-v1' || !Array.isArray(prepared.transfers)) throw new Error('Drive bridge needs the direct-transfer update.');
        leased = true;
        if (prepared.transfers.length !== files.length || new Set(prepared.transfers.map(file => file.name)).size !== files.length) throw new Error('Drive transfer manifest mismatch.');
        for (const transfer of prepared.transfers) {
            const source = files.find(file => file.name === transfer.name);
            if (!source || Number(transfer.sizeBytes) !== source.sizeBytes) throw new Error('Drive transfer source mismatch.');
            await transferToDrive({ ...transfer, md5Hash: source.md5Hash, mimeType: source.mimeType }, async (start, end) => {
                if (source.inlineBytes) return source.inlineBytes.subarray(start, end + 1);
                const [bytes] = await bucket.file(`tips/${sessionLabel}/${source.name}`).download({ start, end });
                return bytes;
            }, { deadline });
        }
        await verifyDriveContents(prepared.folderUrl, files);
        if (onMediaReady) await onMediaReady(prepared.folderUrl);
        // Finalization is idempotent: a lost/invalid response must not delay
        // access to already verified media or require a whole new delivery.
        let finalized;
        try { finalized = await callBridge('finalize'); }
        catch { finalized = await callBridge('finalize'); }
        return normalizeDriveBridgeResponse(finalized, files);
    } finally {
        if (leased) {
            try { await callBridge('release'); } catch { logger.warn('Drive transfer lease will expire automatically.'); }
        }
    }
}

function isApprovedDriveBridgeUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:'
            && url.hostname === 'script.google.com'
            && /^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)
            && !url.username
            && !url.password;
    } catch {
        return false;
    }
}

// Private iPhone Web Push is the tipline notification channel.
Object.assign(exports, require('./tip-alerts'));
