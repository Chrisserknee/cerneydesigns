// ============================================================
// TIPLINE — ntfy push + Google Drive mirror
// Triggers when tips/*/ _submission.json is finalized (after all
// media is already in Storage). Then:
//   1) Mirrors every file in that session folder to a new subfolder
//      under your Google Drive folder (streaming, full originals).
//   2) Sends the ntfy.sh notification (unchanged).
//
// Drive auth: default Cloud Functions service account + Drive API
// scope drive.file. You must share the Drive parent folder with:
//   218726736554-compute@developer.gserviceaccount.com  (Editor)
// ============================================================
const { onObjectFinalized } = require('firebase-functions/v2/storage');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
const { google } = require('googleapis');

admin.initializeApp();

const ntfyTopic = defineSecret('NTFY_TOPIC');

// Google Drive folder ID (from the folder URL). Share this folder with the
// Cloud Functions default service account as Editor — see repo README or
// deploy notes. Change here if you ever use a different folder.
const DRIVE_PARENT_FOLDER_ID = '1bYqiGoCQ9cyx4OHIoM3rJADvkAUh6TIQ';

exports.notifyOnTip = onObjectFinalized(
    {
        region: 'us-west1',
        secrets: [ntfyTopic],
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
            return { name: basename, url, sizeBytes };
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
            const driveMirror = await mirrorSessionToDrive({
                bucket,
                sessionFiles: allSessionFiles,
                sessionLabel,
                parentFolderId: DRIVE_PARENT_FOLDER_ID,
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
 * Streams each Storage object into a new Drive subfolder (original bytes).
 */
async function mirrorSessionToDrive({ bucket, sessionFiles, sessionLabel, parentFolderId }) {
    if (!parentFolderId) {
        logger.warn('DRIVE_FOLDER_ID empty — skipping Drive mirror');
        return;
    }

    const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    const drive = google.drive({ version: 'v3', auth });

    const folderRes = await drive.files.create({
        requestBody: {
            name: sessionLabel.replace(/[/\\]/g, '_'),
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentFolderId],
        },
        fields: 'id',
        supportsAllDrives: true,
    });
    const driveSubFolderId = folderRes.data.id;
    const folderUrl = `https://drive.google.com/drive/folders/${driveSubFolderId}`;

    for (const f of sessionFiles) {
        const basename = (f.name.split('/').pop() || 'file').replace(/[/\\]/g, '_');
        const mimeType = f.metadata.contentType || 'application/octet-stream';
        const readStream = bucket.file(f.name).createReadStream();

        await drive.files.create({
            requestBody: {
                name: basename,
                parents: [driveSubFolderId],
            },
            media: {
                mimeType,
                body: readStream,
            },
            fields: 'id',
            supportsAllDrives: true,
        });
        logger.info(`Drive: uploaded ${basename}`);
    }

    return { folderId: driveSubFolderId, folderUrl };
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
