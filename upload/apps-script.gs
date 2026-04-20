/**
 * ============================================================
 *  CHRIS CERNEY TIPLINE — GOOGLE APPS SCRIPT BACKEND
 * ============================================================
 *
 *  Apps Script opens a Drive resumable upload session and hands
 *  the single-use Drive session URL directly to the browser.
 *  The browser then PUTs file chunks straight to Drive — no
 *  proxying, no base64 bloat, no per-chunk script invocations.
 *
 *  Apps Script is involved only TWICE per upload:
 *    - action=start   → open Drive session, return uploadUrl
 *    - action=finish  → write .info.txt sidecar + email notify
 *
 *  The Drive session URL contains a short-lived upload token;
 *  it only permits PUTs to that specific pre-declared file slot
 *  and expires in ~1 week.
 *
 *  SETUP (one-time):
 *    1. script.google.com → New project
 *    2. Paste this entire file in (replacing the default code)
 *    3. Fill in FOLDER_ID and NOTIFY_EMAIL below
 *    4. Services (+) → add Drive API v3
 *    5. Deploy → New deployment → Web app
 *       - Execute as: Me
 *       - Who has access: Anyone
 *    6. Copy the /exec URL into upload/upload.js SCRIPT_URL
 *
 *  To push code changes:
 *    Deploy → Manage deployments → edit icon → New version → Deploy
 *    (The /exec URL stays the same.)
 * ============================================================
 */

// ==== CONFIGURE THESE TWO LINES ====
const FOLDER_ID = '1bYqiGoCQ9cyx4OHIoM3rJADvkAUh6TIQ';
const NOTIFY_EMAIL = 'captainraptorz@gmail.com';
// ===================================

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.action === 'start')  return jsonOut(handleStart(data));
    if (data.action === 'finish') return jsonOut(handleFinish(data));
    return jsonOut({ error: 'Unknown action: ' + data.action });
  } catch (err) {
    return jsonOut({ error: String(err && err.stack ? err.stack : err) });
  }
}

function doGet() {
  return ContentService
    .createTextOutput('Tipline endpoint. POST only.')
    .setMimeType(ContentService.MimeType.TEXT);
}

/**
 * Open a Drive resumable upload session and return its URL to the browser.
 * The browser will PUT file bytes directly to this URL.
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
      headers: {
        Authorization: 'Bearer ' + token,
        'X-Upload-Content-Type': data.mimeType || 'application/octet-stream',
        'X-Upload-Content-Length': String(Number(data.size) || 0),
      },
      payload: JSON.stringify({
        name: uniqueName,
        parents: [FOLDER_ID],
        mimeType: data.mimeType || 'application/octet-stream',
      }),
      muteHttpExceptions: true,
      followRedirects: false,
    }
  );

  if (res.getResponseCode() >= 300) {
    return { error: 'Drive session init failed (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 500) };
  }

  const headers = res.getAllHeaders();
  const uploadUrl = headers['Location'] || headers['location'];
  if (!uploadUrl) return { error: 'Drive returned no upload URL.' };

  return {
    uploadUrl: uploadUrl,
    storedName: uniqueName,
  };
}

/**
 * Called by the browser after the final PUT to Drive succeeds.
 * Writes a sidecar .info.txt file with submission metadata and
 * emails a notification. The actual uploaded file is already in
 * Drive at this point — these are pure bookkeeping steps.
 */
function handleFinish(data) {
  if (!data.fileId) return { error: 'Missing fileId.' };

  let file;
  try {
    file = DriveApp.getFileById(data.fileId);
  } catch (err) {
    return { error: 'Uploaded file not found: ' + String(err) };
  }

  const folder = DriveApp.getFolderById(FOLDER_ID);
  const receivedAt = new Date();
  const storedName = data.storedName || file.getName();
  const originalName = data.fileName || storedName;
  const size = file.getSize();

  const lines = [
    'Tipline submission',
    '==================',
    'Received:    ' + receivedAt.toString(),
    'File:        ' + originalName,
    'Stored as:   ' + storedName,
    'Size:        ' + formatBytes(size),
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

  folder.createFile(storedName + '.info.txt', info, 'text/plain');

  if (NOTIFY_EMAIL) {
    try {
      MailApp.sendEmail({
        to: NOTIFY_EMAIL,
        subject: 'New tipline submission: ' + originalName,
        body: info + '\n\nFile: ' + file.getUrl() + '\nFolder: https://drive.google.com/drive/folders/' + FOLDER_ID,
      });
    } catch (mailErr) {
      // Don't fail the submission just because the email couldn't send.
      console.error('Email notify failed:', mailErr);
    }
  }

  return { ok: true };
}

function sanitizeFileName(name) {
  return String(name || 'tip').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 180);
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '(unknown)';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
