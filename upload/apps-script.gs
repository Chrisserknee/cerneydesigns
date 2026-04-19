/**
 * ============================================================
 *  CHRIS CERNEY TIPLINE — GOOGLE APPS SCRIPT BACKEND
 * ============================================================
 *
 *  SETUP (one-time, ~10 minutes):
 *
 *  1. Create a folder in your Google Drive where tips should land
 *     (e.g. "Tipline Uploads"). Open the folder and copy its ID from
 *     the URL — it's the long string after /folders/.
 *     Example: https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp
 *     Folder ID = 1AbCdEfGhIjKlMnOp
 *
 *  2. Go to https://script.google.com and click "New project".
 *
 *  3. Delete the default code, paste this entire file in.
 *
 *  4. Paste your folder ID into FOLDER_ID below.
 *
 *  5. (Optional) Put your email in NOTIFY_EMAIL to get an email every
 *     time a new tip comes in. Leave '' to disable.
 *
 *  6. Click the "Services" (+) button in the left sidebar and add
 *     "Drive API" (v3). This is required because we use the Drive
 *     REST resumable upload endpoint.
 *
 *  7. Click Deploy → New deployment → cog icon → Web app.
 *       - Description: "Tipline v1"
 *       - Execute as: Me
 *       - Who has access: Anyone
 *     Click Deploy. Google will ask you to authorize the script —
 *     accept the permissions (it only needs access to Drive and
 *     the ability to send you email if you set NOTIFY_EMAIL).
 *
 *  8. Copy the Web app URL (ends with /exec).
 *
 *  9. In your site, open upload/upload.js and paste the URL into
 *     the SCRIPT_URL constant at the top.
 *
 *  DONE. Test by going to chriscerney.org/upload on your phone.
 *
 *  To update the script later: edit here, then
 *  Deploy → Manage deployments → edit icon → New version → Deploy.
 *  The URL stays the same.
 * ============================================================
 */

// ==== CONFIGURE THESE TWO LINES ====
const FOLDER_ID = 'PASTE_YOUR_DRIVE_FOLDER_ID_HERE';
const NOTIFY_EMAIL = ''; // e.g. 'chrisserknee@gmail.com' — leave '' to skip emails
// ===================================

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    if (data.action === 'start')  return jsonOut(handleStart(data));
    if (data.action === 'finish') return jsonOut(handleFinish(data));

    return jsonOut({ error: 'Unknown action' });
  } catch (err) {
    return jsonOut({ error: err.toString() });
  }
}

function doGet() {
  return ContentService
    .createTextOutput('Tipline endpoint. POST only.')
    .setMimeType(ContentService.MimeType.TEXT);
}

/**
 * Initiate a Drive resumable upload session.
 * Returns a session URL the browser can PUT chunks to directly.
 * The OAuth token is NEVER exposed to the browser — only the session URL.
 */
function handleStart(data) {
  const token = ScriptApp.getOAuthToken();
  const safeName = sanitizeFileName(data.fileName);
  const uniqueName = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd_HH-mm-ss') + '_' + safeName;

  const res = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({
        name: uniqueName,
        parents: [FOLDER_ID],
        mimeType: data.mimeType || 'application/octet-stream',
      }),
      muteHttpExceptions: true,
    }
  );

  if (res.getResponseCode() >= 300) {
    return { error: 'Drive session init failed: ' + res.getContentText() };
  }

  const headers = res.getAllHeaders();
  const uploadUrl = headers['Location'] || headers['location'];
  if (!uploadUrl) return { error: 'No upload URL returned from Drive.' };

  return { uploadUrl: uploadUrl, storedName: uniqueName };
}

/**
 * Called after the browser finishes uploading the file to Drive.
 * Writes a sidecar .info.txt with sender metadata and emails a notification.
 */
function handleFinish(data) {
  const folder = DriveApp.getFolderById(FOLDER_ID);

  const receivedAt = new Date();
  const lines = [
    'Tipline submission',
    '==================',
    'Received:    ' + receivedAt.toString(),
    'File:        ' + data.fileName,
    'Anonymous:   ' + (data.anonymous ? 'yes' : 'no'),
    'Sender name: ' + (data.senderName || '(not provided)'),
    'Contact:     ' + (data.senderContact || '(not provided)'),
    '',
    'Description:',
    data.description || '(none)',
    '',
    'User agent:  ' + (data.userAgent || ''),
  ];
  const info = lines.join('\n');

  folder.createFile(
    Utilities.formatDate(receivedAt, 'UTC', 'yyyy-MM-dd_HH-mm-ss') + '_' + sanitizeFileName(data.fileName) + '.info.txt',
    info,
    'text/plain'
  );

  if (NOTIFY_EMAIL) {
    try {
      MailApp.sendEmail({
        to: NOTIFY_EMAIL,
        subject: 'New tipline submission: ' + data.fileName,
        body: info + '\n\nFolder: https://drive.google.com/drive/folders/' + FOLDER_ID,
      });
    } catch (mailErr) {
      // Don't fail the upload just because the email couldn't send.
      console.error('Email notify failed:', mailErr);
    }
  }

  return { ok: true };
}

function sanitizeFileName(name) {
  return String(name || 'tip').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 180);
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
