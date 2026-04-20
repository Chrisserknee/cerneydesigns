/**
 * ============================================================
 *  CHRIS CERNEY TIPLINE — GOOGLE APPS SCRIPT BACKEND
 * ============================================================
 *
 *  All uploads are proxied through this script, so there is zero
 *  CORS surface between the browser and Google Drive. The script
 *  opens a Drive resumable session server-side and forwards each
 *  base64 chunk it receives from the browser.
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

// Sessions older than this get cleaned up to prevent Properties bloat.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.action === 'start')  return jsonOut(handleStart(data));
    if (data.action === 'chunk')  return jsonOut(handleChunk(data));
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
 * Initiate a server-side Drive resumable upload session.
 * Returns an uploadId the client uses in subsequent chunk/finish calls.
 * The actual Google session URL never leaves the server.
 */
function handleStart(data) {
  cleanupOldSessions();

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
    return { error: 'Drive session init failed (' + res.getResponseCode() + '): ' + res.getContentText() };
  }

  const headers = res.getAllHeaders();
  const sessionUrl = headers['Location'] || headers['location'];
  if (!sessionUrl) return { error: 'Drive returned no upload URL.' };

  const uploadId = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty(
    'session_' + uploadId,
    JSON.stringify({
      sessionUrl: sessionUrl,
      storedName: uniqueName,
      originalName: data.fileName,
      mimeType: data.mimeType || 'application/octet-stream',
      totalSize: Number(data.size) || 0,
      created: Date.now(),
    })
  );

  return { uploadId: uploadId };
}

/**
 * Relay one chunk from the browser to the Drive resumable session.
 * Chunks can be any multiple of 256 KB except the final chunk (Drive requirement).
 */
function handleChunk(data) {
  const props = PropertiesService.getScriptProperties();
  const key = 'session_' + data.uploadId;
  const sessionStr = props.getProperty(key);
  if (!sessionStr) return { error: 'Unknown or expired upload session.' };
  const session = JSON.parse(sessionStr);

  const bytes = Utilities.base64Decode(data.dataBase64);
  const chunkLen = bytes.length;
  const startByte = Number(data.offset);
  const endByte = startByte + chunkLen - 1;
  const totalSize = session.totalSize;

  const res = UrlFetchApp.fetch(session.sessionUrl, {
    method: 'put',
    headers: {
      'Content-Range': 'bytes ' + startByte + '-' + endByte + '/' + totalSize,
    },
    contentType: session.mimeType,
    payload: bytes,
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  if (code === 200 || code === 201) {
    return { ok: true, complete: true };
  }
  if (code === 308) {
    // Drive accepted the chunk and is waiting for more.
    return { ok: true, complete: false };
  }
  return { error: 'Drive chunk rejected (' + code + '): ' + res.getContentText().slice(0, 500) };
}

/**
 * Finalize: write a sidecar .info.txt with sender metadata and email notification.
 */
function handleFinish(data) {
  const props = PropertiesService.getScriptProperties();
  const key = 'session_' + data.uploadId;
  const sessionStr = props.getProperty(key);
  if (!sessionStr) return { error: 'Unknown or expired upload session.' };
  const session = JSON.parse(sessionStr);

  const folder = DriveApp.getFolderById(FOLDER_ID);
  const receivedAt = new Date();
  const lines = [
    'Tipline submission',
    '==================',
    'Received:    ' + receivedAt.toString(),
    'File:        ' + session.originalName,
    'Stored as:   ' + session.storedName,
    'Size:        ' + formatBytes(session.totalSize),
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
    session.storedName + '.info.txt',
    info,
    'text/plain'
  );

  if (NOTIFY_EMAIL) {
    try {
      MailApp.sendEmail({
        to: NOTIFY_EMAIL,
        subject: 'New tipline submission: ' + session.originalName,
        body: info + '\n\nFolder: https://drive.google.com/drive/folders/' + FOLDER_ID,
      });
    } catch (mailErr) {
      // Don't fail the upload just because the email couldn't send.
      console.error('Email notify failed:', mailErr);
    }
  }

  props.deleteProperty(key);
  return { ok: true };
}

function cleanupOldSessions() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const now = Date.now();
  Object.keys(all).forEach(function (key) {
    if (key.indexOf('session_') !== 0) return;
    try {
      const s = JSON.parse(all[key]);
      if (!s.created || (now - s.created) > SESSION_TTL_MS) {
        props.deleteProperty(key);
      }
    } catch (e) {
      props.deleteProperty(key);
    }
  });
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
