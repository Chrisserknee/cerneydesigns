// ============================================================
// TIPLINE PUSH NOTIFIER (via ntfy.sh)
// Triggers whenever a _submission.json sidecar is written to
// tips/* in Firebase Storage, then sends a push notification to
// your phone via ntfy.sh. No email, no third-party account —
// just the ntfy app on your phone subscribed to a private topic.
// ============================================================
const { onObjectFinalized } = require('firebase-functions/v2/storage');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

// Secret topic name. Anyone who knows it can send you notifications,
// so it's stored as a Firebase secret, never committed to git.
const ntfyTopic = defineSecret('NTFY_TOPIC');

exports.notifyOnTip = onObjectFinalized(
    {
        // Must match the region of the Storage bucket (us-west1 for this project).
        region: 'us-west1',
        secrets: [ntfyTopic],
        memory: '256MiB',
        timeoutSeconds: 60,
    },
    async (event) => {
        const object = event.data;
        const filePath = object.name;

        // Only fire on _submission.json (written last by the client), so all
        // other files in the folder are guaranteed to already exist.
        if (!filePath || !filePath.startsWith('tips/') || !filePath.endsWith('/_submission.json')) {
            return null;
        }

        const folder = filePath.substring(0, filePath.lastIndexOf('/'));
        const bucket = admin.storage().bucket(object.bucket);

        let submission = {};
        try {
            const [buf] = await bucket.file(filePath).download();
            submission = JSON.parse(buf.toString('utf8'));
        } catch (err) {
            logger.error('Failed to read submission JSON', err);
        }

        const [files] = await bucket.getFiles({ prefix: folder + '/' });
        const tipFiles = files.filter(f => !f.name.endsWith('/_submission.json'));

        // Build tokenized download URLs using the download tokens that the
        // client SDK already attached at upload time.
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

        // Firebase Console URL for the folder (for the notification tap action).
        const consoleUrl = `https://console.firebase.google.com/project/${process.env.GCLOUD_PROJECT}/storage/${object.bucket}/files/~2F${encodeURIComponent(folder).replace(/%2F/g, '~2F')}`;

        // Build the message body
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

        // Up to 3 clickable action buttons. Priority: Console, then first file.
        const actions = [{ action: 'view', label: 'Open Folder', url: consoleUrl, clear: true }];
        if (fileLinks[0]?.url) {
            actions.push({ action: 'view', label: 'Download First', url: fileLinks[0].url, clear: true });
        }

        const body = {
            topic: ntfyTopic.value(),
            title,
            message,
            priority: 4, // high
            tags: ['camera_flash', 'newspaper'],
            click: consoleUrl,
            actions,
        };

        try {
            const res = await fetch('https://ntfy.sh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const text = await res.text();
                logger.error(`ntfy returned ${res.status}: ${text}`);
            } else {
                logger.info(`Notification sent for ${folder}`);
            }
        } catch (err) {
            logger.error('Failed to POST to ntfy', err);
        }

        return null;
    }
);

function formatBytes(bytes) {
    if (bytes < 1024) return Math.round(bytes) + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
