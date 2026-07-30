// ============================================================
// TIPLINE — ntfy push + Google Drive bridge
// Triggers when tips/*/_submission.json is finalized after all
// media is in Storage, then reliably mirrors it to Google Drive.
// ============================================================
const { randomUUID } = require('node:crypto');
const { onObjectFinalized } = require('firebase-functions/v2/storage');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
const {
    buildManifestMap,
    firstDownloadToken,
    validateSubmission,
} = require('./tipline-helpers');

admin.initializeApp();

const ntfyTopic = defineSecret('NTFY_TOPIC');
const driveBridgeUrl = defineSecret('DRIVE_BRIDGE_URL');
const driveBridgeToken = defineSecret('DRIVE_BRIDGE_TOKEN');

exports.notifyOnTip = onObjectFinalized(
    {
        region: 'us-west1',
        secrets: [ntfyTopic, driveBridgeUrl, driveBridgeToken],
        memory: '1GiB',
        timeoutSeconds: 540,
        retry: true,
    },
    async (event) => {
        const object = event.data;
        const filePath = object.name;

        if (!filePath || !filePath.startsWith('tips/') || !filePath.endsWith('/_submission.json')) {
            return null;
        }

        const folder = filePath.substring(0, filePath.lastIndexOf('/'));
        const bucket = admin.storage().bucket(object.bucket);
        const submissionFile = bucket.file(filePath);
        const sessionLabel = folder.split('/').pop() || 'tip';
        const deliveryId = event.id || `${object.bucket}:${filePath}:${object.generation || 'unknown'}`;

        let submission;
        try {
            const [buf] = await submissionFile.download();
            submission = JSON.parse(buf.toString('utf8'));
        } catch (err) {
            logger.error('Failed to read submission JSON', err);
            throw err;
        }

        const [files] = await bucket.getFiles({ prefix: folder + '/' });
        const tipFiles = files.filter((file) => !file.name.endsWith('/_submission.json'));
        const manifestByStoredName = buildManifestMap(submission);
        const fileLinks = await Promise.all(
            tipFiles.map((file) => buildFileLink(file, object.bucket, manifestByStoredName))
        );
        const integrityWarnings = validateSubmission(submission, fileLinks);
        if (integrityWarnings.length) {
            logger.warn(`Submission integrity warning for ${folder}`, { integrityWarnings });
        }

        const consoleUrl = `https://console.firebase.google.com/project/${process.env.GCLOUD_PROJECT}/storage/${object.bucket}/files/~2F${encodeURIComponent(folder).replace(/%2F/g, '~2F')}`;
        const notification = buildNotification(submission, fileLinks, integrityWarnings, consoleUrl);
        let workflow = await getWorkflowMetadata(submissionFile);
        let driveFolderUrl = workflow.driveFolderUrl || null;

        if (fileLinks.length && workflow.driveCopyStatus !== 'complete') {
            try {
                const driveMirror = await mirrorSessionToDriveBridge({
                    deliveryId,
                    sessionLabel,
                    files: fileLinks,
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
                });
                logger.info(`Drive mirror verified for ${folder}`, {
                    folderUrl: driveFolderUrl,
                    copied: driveMirror.copied.length,
                });
            } catch (err) {
                logger.error('Drive mirror failed; Eventarc will retry', err);
                if (workflow.driveFailureNotified !== 'true') {
                    try {
                        await postNtfy(buildNtfyBody({
                            ...notification,
                            title: `${notification.title} (Drive copy retrying)`,
                            message: `${notification.message}\n\nThe Firebase upload is safe. Google Drive delivery is retrying automatically.`,
                            clickUrl: consoleUrl,
                        }));
                        await mergeWorkflowMetadata(submissionFile, {
                            driveFailureNotified: 'true',
                            driveLastFailureAt: new Date().toISOString(),
                        });
                    } catch (notifyErr) {
                        logger.error('Drive failure notification also failed', notifyErr);
                    }
                }
                throw err;
            }
        } else if (workflow.driveCopyStatus === 'complete') {
            logger.info(`Drive mirror already complete for ${folder}; skipping duplicate copy`);
        }

        workflow = await getWorkflowMetadata(submissionFile);
        if (workflow.notificationStatus !== 'sent') {
            await postNtfy(buildNtfyBody({
                ...notification,
                clickUrl: driveFolderUrl || consoleUrl,
                driveFolderUrl,
            }));
            await mergeWorkflowMetadata(submissionFile, {
                notificationStatus: 'sent',
                notificationSentAt: new Date().toISOString(),
            });
        } else {
            logger.info(`Notification already sent for ${folder}; skipping duplicate`);
        }

        return null;
    }
);

async function buildFileLink(file, bucketName, manifestByStoredName) {
    let metadata = file.metadata || {};
    let customMetadata = metadata.metadata || {};
    let token = firstDownloadToken(customMetadata.firebaseStorageDownloadTokens);

    if (!token) {
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

function buildNotification(submission, fileLinks, integrityWarnings, consoleUrl) {
    const lines = [];
    if (submission.anonymous) {
        lines.push('Anonymous submission');
    } else {
        if (submission.senderName) lines.push(`From: ${submission.senderName}`);
        if (submission.senderContact) lines.push(`Contact: ${submission.senderContact}`);
    }
    if (submission.description) {
        lines.push('');
        lines.push(submission.description.length > 500
            ? submission.description.slice(0, 497) + '...'
            : submission.description);
    }
    if (fileLinks.length) {
        lines.push('');
        lines.push(`Files (${fileLinks.length}):`);
        fileLinks.forEach((file) => lines.push(`• ${file.originalName} (${formatBytes(file.sizeBytes)})`));
    }
    if (integrityWarnings.length) {
        lines.push('');
        lines.push('Upload check needs attention:');
        integrityWarnings.forEach((warning) => lines.push(`• ${warning}`));
    }

    const isStorySubmission = submission.type === 'story_submission';
    return {
        title: isStorySubmission
            ? `New Story Submission${submission.anonymous ? ' (anon)' : ''}`
            : `New Tip: ${fileLinks.length} file${fileLinks.length === 1 ? '' : 's'}${submission.anonymous ? ' (anon)' : ''}`,
        message: lines.join('\n') || (isStorySubmission
            ? 'New story submission received.'
            : 'New tip received.'),
        consoleUrl,
        firstDownloadUrl: fileLinks[0]?.url || null,
    };
}

function buildNtfyBody({
    title,
    message,
    consoleUrl,
    clickUrl,
    driveFolderUrl = null,
    firstDownloadUrl = null,
}) {
    const actions = [];
    if (driveFolderUrl) {
        actions.push({ action: 'view', label: 'Open Drive Folder', url: driveFolderUrl, clear: true });
    }
    actions.push({ action: 'view', label: 'Open Firebase Folder', url: consoleUrl, clear: true });
    if (firstDownloadUrl && actions.length < 3) {
        actions.push({ action: 'view', label: 'Download First', url: firstDownloadUrl, clear: true });
    }

    return {
        topic: ntfyTopic.value(),
        title,
        message,
        priority: 4,
        tags: ['camera_flash', 'newspaper'],
        click: clickUrl,
        actions,
    };
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
async function mirrorSessionToDriveBridge({ deliveryId, sessionLabel, files, submission }) {
    const url = driveBridgeUrl.value();
    if (!url || !url.startsWith('https://script.google.com/')) {
        throw new Error('DRIVE_BRIDGE_URL is not configured.');
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
            token: driveBridgeToken.value(),
            deliveryId,
            sessionLabel,
            submission,
            files,
        }),
    });

    const text = await res.text();
    let payload = {};
    try {
        payload = text ? JSON.parse(text) : {};
    } catch {
        throw new Error(`Drive bridge returned non-JSON response: ${text.slice(0, 200)}`);
    }

    if (!res.ok || !payload.ok || payload.error) {
        throw new Error(payload.error || `Drive bridge HTTP ${res.status}`);
    }
    if (!payload.complete || !payload.folderUrl || !Array.isArray(payload.copied)) {
        throw new Error('Drive bridge did not confirm a complete, verified copy.');
    }
    if (payload.copied.length !== files.length) {
        throw new Error(`Drive bridge verified ${payload.copied.length} of ${files.length} files.`);
    }

    return payload;
}

async function postNtfy(body) {
    const res = await fetch('https://ntfy.sh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`ntfy ${res.status}: ${text}`);
    }
    logger.info('ntfy notification sent');
}

function formatBytes(bytes) {
    if (bytes < 1024) return Math.round(bytes) + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
