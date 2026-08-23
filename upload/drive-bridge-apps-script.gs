// ============================================================
// TIPLINE DRIVE BRIDGE
// Google Apps Script web app that runs as Chris's Google account.
//
// Required Script Properties:
//   DRIVE_BRIDGE_TOKEN = same secret stored in Firebase
// ============================================================

const PARENT_FOLDER_ID = '1bYqiGoCQ9cyx4OHIoM3rJADvkAUh6TIQ';
const CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB: fewer requests, below Apps Script's 50 MB UrlFetch limit.
const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 750 * 1024 * 1024;
const MAX_RETRIES = 4;
const SOFT_RUNTIME_LIMIT_MS = 4.5 * 60 * 1000;
const COMPLETION_FILE = '_DRIVE_COPY_COMPLETE.json';

function doPost(e) {
  const startedAt = Date.now();
  try {
    const payload = JSON.parse(e.postData && e.postData.contents ? e.postData.contents : '{}');
    verifyToken_(payload.token);

    const files = Array.isArray(payload.files) ? payload.files : [];
    if (files.length < 1) throw new Error('No files supplied.');
    if (files.length > MAX_FILES) throw new Error('Too many files for Drive bridge.');

    const totalBytes = files.reduce(function(sum, file) {
      return sum + Number(file.sizeBytes || 0);
    }, 0);
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Submission is too large for Drive bridge.');

    const sessionLabel = safeName_(payload.sessionLabel || ('tip-' + new Date().toISOString()));
    const sessionFolder = getOrCreateSessionFolder_(sessionLabel);
    const completed = readValidCompletion_(sessionFolder, sessionLabel, files);
    if (completed) {
      return json_({
        ok: true,
        complete: true,
        resumed: true,
        folderId: sessionFolder.getId(),
        folderUrl: sessionFolder.getUrl(),
        copied: completed.files
      });
    }

    const copied = [];
    files.forEach(function(file) {
      ensureRuntime_(startedAt);
      copied.push(mirrorFile_(file, sessionFolder.getId(), sessionLabel, startedAt));
    });

    const submission = payload.submission || {};
    createOrReplaceTextFile_(
      sessionFolder,
      '_submission.json',
      JSON.stringify({
        copiedAt: new Date().toISOString(),
        deliveryId: payload.deliveryId || '',
        sessionLabel: sessionLabel,
        submission: submission,
        files: files.map(function(file) {
          return {
            name: file.name,
            originalName: file.originalName || file.name,
            sizeBytes: Number(file.sizeBytes || 0),
            mimeType: file.mimeType,
            md5Hash: file.md5Hash || ''
          };
        }),
        verifiedCopies: copied
      }, null, 2),
      'application/json'
    );

    createOrReplaceTextFile_(
      sessionFolder,
      '00_TIP_INFO.txt',
      buildTipInfoText_(submission, files, sessionLabel),
      'text/plain'
    );

    createOrReplaceTextFile_(
      sessionFolder,
      COMPLETION_FILE,
      JSON.stringify({
        complete: true,
        completedAt: new Date().toISOString(),
        deliveryId: payload.deliveryId || '',
        sessionLabel: sessionLabel,
        files: copied
      }, null, 2),
      'application/json'
    );

    return json_({
      ok: true,
      complete: true,
      folderId: sessionFolder.getId(),
      folderUrl: sessionFolder.getUrl(),
      copied: copied
    });
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return json_({
      ok: false,
      retryable: true,
      error: err && err.message ? err.message : String(err)
    });
  }
}

function getOrCreateSessionFolder_(sessionLabel) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const properties = PropertiesService.getScriptProperties();
    const propertyKey = 'folder_' + hash_(sessionLabel);
    const knownId = properties.getProperty(propertyKey);
    if (knownId) {
      try {
        return DriveApp.getFolderById(knownId);
      } catch (err) {
        properties.deleteProperty(propertyKey);
      }
    }

    const parent = DriveApp.getFolderById(PARENT_FOLDER_ID);
    const existing = parent.getFoldersByName(sessionLabel);
    if (existing.hasNext()) {
      const folder = existing.next();
      properties.setProperty(propertyKey, folder.getId());
      return folder;
    }

    const created = parent.createFolder(sessionLabel);
    properties.setProperty(propertyKey, created.getId());
    return created;
  } finally {
    lock.releaseLock();
  }
}

function readValidCompletion_(folder, sessionLabel, expectedFiles) {
  const markers = folder.getFilesByName(COMPLETION_FILE);
  while (markers.hasNext()) {
    try {
      const marker = JSON.parse(markers.next().getBlob().getDataAsString());
      if (!marker.complete || marker.sessionLabel !== sessionLabel || !Array.isArray(marker.files)) {
        continue;
      }
      if (marker.files.length !== expectedFiles.length) continue;

      const expected = {};
      expectedFiles.forEach(function(file) {
        expected[safeName_(file.name || 'upload')] = {
          sizeBytes: Number(file.sizeBytes || 0),
          md5Hex: md5Base64ToHex_(file.md5Hash || '')
        };
      });

      const valid = marker.files.every(function(file) {
        const match = expected[file.name];
        if (!match || Number(file.sizeBytes) !== match.sizeBytes || !file.verified) return false;
        if (match.md5Hex && String(file.md5Checksum || '').toLowerCase() !== match.md5Hex) {
          return false;
        }
        try {
          verifyDriveFile_(file.id, file.name, match.sizeBytes, match.md5Hex);
          return true;
        } catch (err) {
          return false;
        }
      });
      if (valid) return marker;
    } catch (err) {
      console.warn('Ignoring invalid completion marker: ' + err);
    }
  }
  return null;
}

function createOrReplaceTextFile_(folder, name, content, mimeType) {
  const existing = folder.getFilesByName(name);
  while (existing.hasNext()) {
    existing.next().setTrashed(true);
  }
  return folder.createFile(Utilities.newBlob(content, mimeType, name));
}

function buildTipInfoText_(submission, files, sessionLabel) {
  const lines = [];
  lines.push('TIP INFORMATION');
  lines.push('===============');
  lines.push('');
  lines.push('Folder: ' + sessionLabel);
  lines.push('Copied to Drive: ' + new Date().toLocaleString());
  if (submission.submittedAt) lines.push('Submitted: ' + submission.submittedAt);
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
  files.forEach(function(file, idx) {
    const originalName = file.originalName || file.name || 'upload';
    const storageName = file.name && file.name !== originalName ? ' (stored as ' + file.name + ')' : '';
    lines.push(
      (idx + 1) + '. ' +
      originalName +
      storageName +
      ' - ' +
      formatBytes_(Number(file.sizeBytes || 0))
    );
  });

  if (submission.deliveryAudit && Array.isArray(submission.deliveryAudit.warnings) &&
      submission.deliveryAudit.warnings.length) {
    lines.push('');
    lines.push('UPLOAD CHECK WARNINGS:');
    submission.deliveryAudit.warnings.forEach(function(warning) {
      lines.push('- ' + warning);
    });
  }

  lines.push('');
  lines.push('Privacy note: files may be used in news coverage. Anonymous submissions do not include sender name/contact.');
  return lines.join('\n');
}

function mirrorFile_(file, folderId, sessionLabel, startedAt) {
  if (!file || !file.url) throw new Error('File is missing a download URL.');
  if (!/^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/tip-line-8c2d7\.firebasestorage\.app\/o\//.test(String(file.url))) {
    throw new Error('Rejected non-Firebase download URL.');
  }

  const name = safeName_(file.name || 'upload');
  const mimeType = file.mimeType || 'application/octet-stream';
  const size = Number(file.sizeBytes || 0);
  const expectedMd5 = md5Base64ToHex_(file.md5Hash || '');
  const folder = DriveApp.getFolderById(folderId);

  const existing = folder.getFilesByName(name);
  while (existing.hasNext()) {
    const existingFile = existing.next();
    const sameSize = Number(existingFile.getSize()) === size;
    const existingMd5 = String(existingFile.getMd5Checksum() || '').toLowerCase();
    const sameChecksum = !expectedMd5 || existingMd5 === expectedMd5;
    if (sameSize && sameChecksum) {
      return {
        name: name,
        id: existingFile.getId(),
        sizeBytes: size,
        md5Checksum: existingMd5,
        skipped: true,
        verified: true
      };
    }
    existingFile.setTrashed(true);
  }

  if (size === 0) {
    const created = folder.createFile(Utilities.newBlob('', mimeType, name));
    return verifyDriveFile_(created.getId(), name, size, expectedMd5);
  }

  const properties = PropertiesService.getScriptProperties();
  const stateKey = 'upload_' + hash_(sessionLabel + '|' + folderId + '|' + name + '|' + size);
  let state = readUploadState_(properties, stateKey);
  let uploadUrl = state && state.uploadUrl ? state.uploadUrl : '';
  let offset = 0;

  if (uploadUrl) {
    const remoteState = queryDriveUpload_(uploadUrl, size);
    if (remoteState.expired) {
      properties.deleteProperty(stateKey);
      uploadUrl = '';
    } else if (remoteState.complete) {
      const verified = verifyDriveFile_(remoteState.id, name, size, expectedMd5);
      properties.deleteProperty(stateKey);
      return verified;
    } else {
      offset = remoteState.nextOffset;
    }
  }

  if (!uploadUrl) {
    uploadUrl = startDriveUpload_(folderId, name, mimeType, size);
    offset = 0;
  }
  saveUploadState_(properties, stateKey, uploadUrl, offset, size, name);

  while (offset < size) {
    ensureRuntime_(startedAt);
    const end = Math.min(offset + CHUNK_SIZE, size) - 1;
    const firebaseRes = fetchWithRetry_(file.url, {
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
    const expectedLength = end - offset + 1;
    if (!bytes.length) throw new Error('Firebase returned an empty chunk for ' + name);
    if (fetchCode === 206 && bytes.length !== expectedLength) {
      throw new Error('Firebase returned a partial range for ' + name);
    }
    if (fetchCode === 200 && !(offset === 0 && bytes.length === size)) {
      throw new Error('Firebase ignored range request for ' + name);
    }

    const uploadResult = uploadDriveChunk_(
      uploadUrl,
      bytes,
      mimeType,
      offset,
      offset + bytes.length - 1,
      size
    );
    if (uploadResult.complete) {
      const verified = verifyDriveFile_(uploadResult.id, name, size, expectedMd5);
      properties.deleteProperty(stateKey);
      return verified;
    }
    if (uploadResult.nextOffset <= offset) {
      throw new Error('Drive upload made no progress for ' + name);
    }

    offset = uploadResult.nextOffset;
    saveUploadState_(properties, stateKey, uploadUrl, offset, size, name);
  }

  const finalState = queryDriveUpload_(uploadUrl, size);
  if (!finalState.complete) throw new Error('Drive did not finalize ' + name);
  const verified = verifyDriveFile_(finalState.id, name, size, expectedMd5);
  properties.deleteProperty(stateKey);
  return verified;
}

function startDriveUpload_(folderId, name, mimeType, size) {
  const url = 'https://www.googleapis.com/upload/drive/v3/files' +
    '?uploadType=resumable&fields=id%2Cname%2Csize%2Cmd5Checksum';
  const res = fetchWithRetry_(url, {
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
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
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
      const parsed = parseUploadResponse_(res, total);
      if (parsed.ok) return parsed;
      lastErr = new Error('Drive chunk upload failed (HTTP ' + parsed.code + '): ' + res.getContentText());
    } catch (err) {
      lastErr = err;
    }

    try {
      const remoteState = queryDriveUpload_(uploadUrl, total);
      if (remoteState.complete || remoteState.nextOffset > start) return remoteState;
      if (remoteState.expired) throw new Error('Drive upload session expired.');
    } catch (statusErr) {
      lastErr = statusErr;
    }

    if (attempt < MAX_RETRIES) {
      Utilities.sleep(Math.min(30000, 1000 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

function queryDriveUpload_(uploadUrl, total) {
  const res = UrlFetchApp.fetch(uploadUrl, {
    method: 'put',
    payload: '',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'Content-Range': 'bytes */' + total
    },
    muteHttpExceptions: true
  });
  const parsed = parseUploadResponse_(res, total);
  if (parsed.ok) return parsed;
  if (parsed.code === 404 || parsed.code === 410) return { expired: true, nextOffset: 0 };
  throw new Error('Drive upload status failed (HTTP ' + parsed.code + '): ' + res.getContentText());
}

function parseUploadResponse_(response, total) {
  const code = response.getResponseCode();
  if (code === 200 || code === 201) {
    const body = response.getContentText();
    let metadata = {};
    try {
      metadata = body ? JSON.parse(body) : {};
    } catch (err) {
      throw new Error('Drive returned invalid completion metadata.');
    }
    if (!metadata.id) throw new Error('Drive completion response is missing a file ID.');
    return {
      ok: true,
      complete: true,
      nextOffset: total,
      id: metadata.id
    };
  }
  if (code === 308) {
    return {
      ok: true,
      complete: false,
      nextOffset: rangeNextOffset_(header_(response, 'Range'))
    };
  }
  return { ok: false, code: code, complete: false, nextOffset: 0 };
}

function verifyDriveFile_(fileId, name, expectedSize, expectedMd5) {
  if (!fileId) throw new Error('Drive did not return an ID for ' + name);
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const driveFile = DriveApp.getFileById(fileId);
      const actualSize = Number(driveFile.getSize());
      const actualMd5 = String(driveFile.getMd5Checksum() || '').toLowerCase();

      if (actualSize !== expectedSize) {
        throw new Error('Drive size check failed for ' + name + ' (expected ' + expectedSize + ', got ' + actualSize + ')');
      }
      if (expectedMd5 && actualMd5 !== expectedMd5) {
        throw new Error('Drive checksum check failed for ' + name);
      }

      return {
        name: name,
        id: fileId,
        sizeBytes: actualSize,
        md5Checksum: actualMd5,
        verified: true
      };
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) Utilities.sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr;
}

function fetchWithRetry_(url, options) {
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = UrlFetchApp.fetch(url, options);
      const code = res.getResponseCode();
      if (code < 500 && code !== 429) return res;
      lastErr = new Error('HTTP ' + code + ': ' + res.getContentText());
    } catch (err) {
      lastErr = err;
    }

    if (attempt < MAX_RETRIES) {
      Utilities.sleep(Math.min(30000, 1000 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

function readUploadState_(properties, key) {
  const raw = properties.getProperty(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    properties.deleteProperty(key);
    return null;
  }
}

function saveUploadState_(properties, key, uploadUrl, offset, size, name) {
  properties.setProperty(key, JSON.stringify({
    uploadUrl: uploadUrl,
    offset: offset,
    size: size,
    name: name,
    updatedAt: new Date().toISOString()
  }));
}

function rangeNextOffset_(rangeHeader) {
  if (!rangeHeader) return 0;
  const match = String(rangeHeader).match(/bytes\s*=\s*0-(\d+)/i);
  return match ? Number(match[1]) + 1 : 0;
}

function md5Base64ToHex_(value) {
  if (!value) return '';
  try {
    return Utilities.base64Decode(String(value)).map(function(byte) {
      return (byte & 255).toString(16).padStart(2, '0');
    }).join('');
  } catch (err) {
    throw new Error('Invalid source checksum.');
  }
}

function ensureRuntime_(startedAt) {
  if (Date.now() - startedAt >= SOFT_RUNTIME_LIMIT_MS) {
    throw new Error('Drive copy paused before the Apps Script time limit; it will resume automatically.');
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

function hash_(value) {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8
  ).map(function(byte) {
    return (byte & 255).toString(16).padStart(2, '0');
  }).join('');
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
