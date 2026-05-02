// ============================================================
// TIPLINE DRIVE BRIDGE
// Google Apps Script web app that runs as Chris's Google account.
//
// Firebase uploads stay fast. After a completed upload, the Cloud
// Function sends this script tokenized Firebase download URLs. This
// script copies the original files into the Google Drive Tips folder.
//
// Required Script Properties:
//   DRIVE_BRIDGE_TOKEN = same secret stored in Firebase
// ============================================================

const PARENT_FOLDER_ID = '1bYqiGoCQ9cyx4OHIoM3rJADvkAUh6TIQ';
const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB; safely below Apps Script UrlFetch limits.
const MAX_FILES = 30;
const MAX_TOTAL_BYTES = 750 * 1024 * 1024; // Firebase remains source of truth if Drive copy times out.

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData && e.postData.contents ? e.postData.contents : '{}');
    verifyToken_(payload.token);

    const files = Array.isArray(payload.files) ? payload.files : [];
    if (files.length < 1) throw new Error('No files supplied.');
    if (files.length > MAX_FILES) throw new Error('Too many files for Drive bridge.');

    const totalBytes = files.reduce((sum, f) => sum + Number(f.sizeBytes || 0), 0);
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Submission is too large for Drive bridge.');

    const parent = DriveApp.getFolderById(PARENT_FOLDER_ID);
    const sessionLabel = safeName_(payload.sessionLabel || ('tip-' + new Date().toISOString()));
    const sessionFolder = parent.createFolder(sessionLabel);

    const submission = payload.submission || {};
    const submissionBlob = Utilities.newBlob(
      JSON.stringify({
        copiedAt: new Date().toISOString(),
        sessionLabel: sessionLabel,
        submission: submission,
        files: files.map(function(f) {
          return {
            name: f.name,
            sizeBytes: f.sizeBytes,
            mimeType: f.mimeType
          };
        })
      }, null, 2),
      'application/json',
      '_submission.json'
    );
    sessionFolder.createFile(submissionBlob);

    const tipInfoBlob = Utilities.newBlob(
      buildTipInfoText_(submission, files, sessionLabel),
      'text/plain',
      '00_TIP_INFO.txt'
    );
    sessionFolder.createFile(tipInfoBlob);

    const copied = [];
    files.forEach(function(file) {
      const result = mirrorFile_(file, sessionFolder.getId());
      copied.push(result);
    });

    return json_({
      ok: true,
      folderId: sessionFolder.getId(),
      folderUrl: sessionFolder.getUrl(),
      copied: copied
    });
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return json_({
      ok: false,
      error: err && err.message ? err.message : String(err)
    });
  }
}

function buildTipInfoText_(submission, files, sessionLabel) {
  const lines = [];
  lines.push('TIP INFORMATION');
  lines.push('===============');
  lines.push('');
  lines.push('Folder: ' + sessionLabel);
  lines.push('Copied to Drive: ' + new Date().toLocaleString());
  if (submission.submittedAt) {
    lines.push('Submitted: ' + submission.submittedAt);
  }
  lines.push('');

  if (submission.anonymous) {
    lines.push('Sender: Anonymous');
  } else {
    lines.push('Sender Name: ' + (submission.senderName || '(not provided)'));
    lines.push('Sender Contact: ' + (submission.senderContact || '(not provided)'));
  }

  lines.push('');
  lines.push('What this tip is about:');
  lines.push(submission.description || '(not provided)');
  lines.push('');
  lines.push('Files:');

  if (!files.length) {
    lines.push('(no files listed)');
  } else {
    files.forEach(function(file, idx) {
      lines.push(
        (idx + 1) + '. ' +
        (file.name || 'upload') +
        ' - ' +
        formatBytes_(Number(file.sizeBytes || 0))
      );
    });
  }

  lines.push('');
  lines.push('Privacy note: files may be used in news coverage. Anonymous submissions do not include sender name/contact.');
  return lines.join('\n');
}

function mirrorFile_(file, folderId) {
  if (!file || !file.url) throw new Error('File is missing a download URL.');
  if (!String(file.url).startsWith('https://firebasestorage.googleapis.com/')) {
    throw new Error('Rejected non-Firebase download URL.');
  }

  const name = safeName_(file.name || 'upload');
  const mimeType = file.mimeType || 'application/octet-stream';
  const size = Number(file.sizeBytes || 0);

  if (size === 0) {
    const empty = Utilities.newBlob('', mimeType, name);
    const created = DriveApp.getFolderById(folderId).createFile(empty);
    return { name: name, id: created.getId(), sizeBytes: 0 };
  }

  const uploadUrl = startDriveUpload_(folderId, name, mimeType, size);
  let offset = 0;

  while (offset < size) {
    const end = Math.min(offset + CHUNK_SIZE, size) - 1;
    const firebaseRes = UrlFetchApp.fetch(file.url, {
      method: 'get',
      headers: {
        Range: 'bytes=' + offset + '-' + end,
        'Accept-Encoding': 'identity'
      },
      muteHttpExceptions: true,
      followRedirects: true
    });

    const fetchCode = firebaseRes.getResponseCode();
    if (fetchCode !== 206 && fetchCode !== 200) {
      throw new Error('Firebase download failed for ' + name + ' (HTTP ' + fetchCode + ')');
    }

    const bytes = firebaseRes.getBlob().getBytes();
    if (!bytes.length) throw new Error('Firebase returned an empty chunk for ' + name);

    const chunkStart = offset;
    const chunkEnd = offset + bytes.length - 1;
    uploadDriveChunk_(uploadUrl, bytes, mimeType, chunkStart, chunkEnd, size);
    offset += bytes.length;
  }

  return { name: name, sizeBytes: size };
}

function startDriveUpload_(folderId, name, mimeType, size) {
  const res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({
      name: name,
      parents: [folderId]
    }),
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(size)
    },
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Drive upload session failed for ' + name + ' (HTTP ' + code + '): ' + res.getContentText());
  }

  const location = header_(res, 'Location');
  if (!location) throw new Error('Drive did not return a resumable upload URL for ' + name);
  return location;
}

function uploadDriveChunk_(uploadUrl, bytes, mimeType, start, end, total) {
  const res = UrlFetchApp.fetch(uploadUrl, {
    method: 'put',
    contentType: mimeType,
    payload: bytes,
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total
    },
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  if (code !== 200 && code !== 201 && code !== 308) {
    throw new Error('Drive chunk upload failed (HTTP ' + code + '): ' + res.getContentText());
  }
}

function verifyToken_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty('DRIVE_BRIDGE_TOKEN');
  if (!expected) throw new Error('DRIVE_BRIDGE_TOKEN script property is not configured.');
  if (!token || token !== expected) throw new Error('Unauthorized.');
}

function safeName_(name) {
  return String(name)
    .replace(/[\\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'upload';
}

function formatBytes_(bytes) {
  if (bytes < 1024) return Math.round(bytes) + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function header_(response, name) {
  const headers = response.getAllHeaders();
  const lower = name.toLowerCase();
  for (const key in headers) {
    if (String(key).toLowerCase() === lower) return headers[key];
  }
  return null;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
