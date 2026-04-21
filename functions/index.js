// ============================================================
// TIPLINE EMAIL NOTIFIER
// Triggers whenever a _submission.json sidecar is written to
// tips/* in Firebase Storage, then emails the recipient a
// summary with direct download links to each uploaded file.
// ============================================================
const { onObjectFinalized } = require('firebase-functions/v2/storage');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
const { Resend } = require('resend');

admin.initializeApp();

const resendApiKey = defineSecret('RESEND_API_KEY');

// Where to send tip notifications. Hardcoded on purpose so the user
// doesn't have to manage yet another secret.
const NOTIFY_EMAIL = 'captainraptorz@gmail.com';

// Resend's sandbox sender. No domain verification required; delivers
// to the email address you used to sign up for Resend.
const FROM_EMAIL = 'Tipline <onboarding@resend.dev>';

exports.notifyOnTip = onObjectFinalized(
    {
        // Must match the region of the Storage bucket (us-west1 for this project).
        region: 'us-west1',
        secrets: [resendApiKey],
        // Reasonable ceiling — this function is tiny and infrequent.
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

        // Parse the submission metadata
        let submission = {};
        try {
            const [buf] = await bucket.file(filePath).download();
            submission = JSON.parse(buf.toString('utf8'));
        } catch (err) {
            logger.error('Failed to read submission JSON', err);
        }

        // Gather all sibling files (the actual tip media)
        const [files] = await bucket.getFiles({ prefix: folder + '/' });
        const tipFiles = files.filter(f => !f.name.endsWith('/_submission.json'));

        // Build download URLs using the download tokens that the client SDK
        // already attached at upload time. Avoids the IAM friction that
        // getSignedUrl() requires.
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

        const senderBlock = submission.anonymous
            ? '<p style="margin:0 0 12px 0"><strong>Anonymous submission</strong></p>'
            : `<table style="border-collapse:collapse;margin:0 0 12px 0">
                  <tr><td style="padding:2px 12px 2px 0;color:#666">Name</td><td>${escapeHtml(submission.senderName || '(not provided)')}</td></tr>
                  <tr><td style="padding:2px 12px 2px 0;color:#666">Contact</td><td>${escapeHtml(submission.senderContact || '(not provided)')}</td></tr>
               </table>`;

        const descriptionBlock = submission.description
            ? `<p style="margin:0 0 12px 0"><strong>Description</strong><br>${escapeHtml(submission.description).replace(/\n/g, '<br>')}</p>`
            : '';

        const filesBlock = fileLinks.length
            ? '<ul style="margin:0 0 12px 0;padding-left:20px">' + fileLinks.map(f => {
                const sizeStr = formatBytes(f.sizeBytes);
                return f.url
                    ? `<li style="margin:4px 0"><a href="${f.url}">${escapeHtml(f.name)}</a> <span style="color:#888">(${sizeStr})</span></li>`
                    : `<li style="margin:4px 0">${escapeHtml(f.name)} <span style="color:#888">(${sizeStr})</span></li>`;
            }).join('') + '</ul>'
            : '<p>(no files found)</p>';

        const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;color:#222">
  <h2 style="margin:0 0 16px 0;font-size:20px">New Tip Received</h2>
  ${senderBlock}
  ${descriptionBlock}
  <p style="margin:0 0 8px 0"><strong>Files (${fileLinks.length})</strong></p>
  ${filesBlock}
  <p style="margin:16px 0 0 0"><a href="${consoleUrl}" style="color:#0a66c2">Open folder in Firebase Console</a></p>
  <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
  <p style="color:#888;font-size:12px;margin:0">Submitted ${escapeHtml(submission.submittedAt || new Date().toISOString())}</p>
</div>`.trim();

        const subject = `New Tip: ${fileLinks.length} file${fileLinks.length === 1 ? '' : 's'}${submission.anonymous ? ' (anonymous)' : ''}`;

        const resend = new Resend(resendApiKey.value());
        try {
            await resend.emails.send({
                from: FROM_EMAIL,
                to: NOTIFY_EMAIL,
                subject,
                html,
            });
            logger.info(`Notification email sent for ${folder}`);
        } catch (err) {
            logger.error('Failed to send notification email', err);
        }

        return null;
    }
);

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[c]));
}

function formatBytes(bytes) {
    if (bytes < 1024) return Math.round(bytes) + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
