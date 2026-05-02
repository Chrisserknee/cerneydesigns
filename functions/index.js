// ============================================================
// TIPLINE — ntfy push + Google Drive bridge
// Triggers when tips/*/ _submission.json is finalized (after all
// media is already in Storage). Then:
//   1) Calls an Apps Script bridge that runs as Chris and mirrors
//      each original Firebase file into the Google Drive Tips folder.
//   2) Sends the ntfy.sh notification (unchanged).
// ============================================================
const { onObjectFinalized } = require('firebase-functions/v2/storage');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

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
    },
    async (event) => {
        const object = event.data;
        const filePath = object.name;

        if (!filePath || !filePath.startsWith('tips/') || !filePath.endsWith('/_submission.json')) {
            return null;
        }

        const folder = filePath.substring(0, filePath.lastIndexOf('/'));
        const bucket = admin.storage().bucket(object.bucket);
        const sessionLabel = folder.split('/').pop() || 'tip';

        let submission = {};
        try {
            const [buf] = await bucket.file(filePath).download();
            submission = JSON.parse(buf.toString('utf8'));
        } catch (err) {
            logger.error('Failed to read submission JSON', err);
        }

        const [files] = await bucket.getFiles({ prefix: folder + '/' });
        const tipFiles = files.filter(f => !f.name.endsWith('/_submission.json'));
        const allSessionFiles = files.filter((f) => !f.name.endsWith('/'));

        const fileLinks = tipFiles.map((f) => {
            const tokens = f.metadata.metadata?.firebaseStorageDownloadTokens;
            const firstToken = tokens ? String(tokens).split(',')[0] : null;
            const encodedPath = encodeURIComponent(f.name);
            const url = firstToken
                ? `https://firebasestorage.googleapis.com/v0/b/${object.bucket}/o/${encodedPath}?alt=media&token=${firstToken}`
                : null;
            const basename = f.name.split('/').pop();
            const sizeBytes = Number(f.metadata.size || 0);
            const mimeType = f.metadata.contentType || 'application/octet-stream';
            return { name: basename, url, sizeBytes, mimeType };
        });

        const consoleUrl = `https://console.firebase.google.com/project/${process.env.GCLOUD_PROJECT}/storage/${object.bucket}/files/~2F${encodeURIComponent(folder).replace(/%2F/g, '~2F')}`;

        const lines = [];
        if (submission.anonymous) {
            lines.push('Anonymous submission');
        } else {
            if (submission.senderName) lines.push(`From: ${submission.senderName}`);
            if (submission.senderContact) lines.push(`Contact: ${submission.senderContact}`);
        }
        if (submission.description) {
            lines.push('');
            lines.push(submission.description.length > 500 ? submission.description.slice(0, 497) + '...' : submission.description);
        }
        if (fileLinks.length) {
            lines.push('');
            lines.push(`Files (${fileLinks.length}):`);
            fileLinks.forEach(f => lines.push(`• ${f.name} (${formatBytes(f.sizeBytes)})`));
        }

        const title = `New Tip: ${fileLinks.length} file${fileLinks.length === 1 ? '' : 's'}${submission.anonymous ? ' (anon)' : ''}`;
        const message = lines.join('\n') || 'New tip received.';

        let driveFolderUrl = null;
        let driveError = null;
        try {
            const driveMirror = await mirrorSessionToDriveBridge({
                sessionLabel,
                files: fileLinks,
                submission,
            });
            driveFolderUrl = driveMirror.folderUrl;
            logger.info(`Drive mirror OK for ${folder}`);
        } catch (err) {
            driveError = err;
            logger.error('Drive mirror failed', err);
        }

        const actions = [];
        if (driveFolderUrl) {
            actions.push({ action: 'view', label: 'Open Drive Folder', url: driveFolderUrl, clear: true });
        }
        actions.push({ action: 'view', label: 'Open Firebase Folder', url: consoleUrl, clear: true });
        if (fileLinks[0]?.url && actions.length < 3) {
            actions.push({ action: 'view', label: 'Download First', url: fileLinks[0].url, clear: true });
        }

        const ntfyBody = {
            topic: ntfyTopic.value(),
            title: driveError ? `${title} (Drive copy failed)` : title,
            message: driveError
                ? `${message}\n\nDrive copy failed, but Firebase upload is safe.`
                : message,
            priority: 4,
            tags: ['camera_flash', 'newspaper'],
            click: driveFolderUrl || consoleUrl,
            actions,
        };

        try {
            await postNtfy(ntfyBody);
        } catch (err) {
            logger.error('ntfy failed', err);
        }

        return null;
    }
);

/**
 * Calls the Apps Script bridge. The bridge runs as Chris's Google account,
 * which avoids the personal-Drive quota issue service accounts hit.
 */
async function mirrorSessionToDriveBridge({ sessionLabel, files, submission }) {
    const url = driveBridgeUrl.value();
    if (!url || !url.startsWith('https://script.google.com/')) {
        throw new Error('DRIVE_BRIDGE_URL is not configured.');
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
            token: driveBridgeToken.value(),
            sessionLabel,
            submission,
            files: files.filter((f) => f.url),
        }),
    });

    const text = await res.text();
    let payload = {};
    try {
        payload = text ? JSON.parse(text) : {};
    } catch {
        throw new Error(`Drive bridge returned non-JSON response: ${text.slice(0, 200)}`);
    }

    if (!res.ok || payload.error) {
        throw new Error(payload.error || `Drive bridge HTTP ${res.status}`);
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
