// ============================================================
// TIPLINE UPLOAD CLIENT
//
// Architecture:
//   1. POST to Apps Script action=start  → returns a Drive resumable
//      upload session URL (generated server-side by Apps Script using
//      its OAuth token).
//   2. PUT chunks directly from the browser to that Drive session URL.
//      No Apps Script in the path for file bytes → no base64 overhead,
//      no double hop, and upload.onprogress works cleanly because Drive
//      handles CORS properly.
//   3. POST to Apps Script action=finish with the returned fileId → it
//      writes a .info.txt sidecar and emails the submission notice.
// ============================================================
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbw_xPCXhuU7gMn4MyV1q6FOmWZpNbvuWgWJwrr-zJdaJCG1Bz4I4WfUMFUCdmxugj2E/exec';
// ============================================================

// 8 MB raw chunks. Uploaded directly to Drive (no base64), so what the
// browser sends is exactly what Drive stores — no overhead. Must be a
// multiple of 256 KB per Drive's resumable upload spec.
const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CHUNK_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 1500;

const els = {
    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('fileInput'),
    fileList: document.getElementById('fileList'),
    submitBtn: document.getElementById('submitBtn'),
    uploader: document.getElementById('uploader'),
    progressScreen: document.getElementById('progressScreen'),
    progressBar: document.getElementById('progressBar'),
    progressPercent: document.getElementById('progressPercent'),
    progressFile: document.getElementById('progressFile'),
    progressStatus: document.getElementById('progressStatus'),
    thankyouScreen: document.getElementById('thankyouScreen'),
    errorScreen: document.getElementById('errorScreen'),
    errorBody: document.getElementById('errorBody'),
    sendAnother: document.getElementById('sendAnother'),
    errorRetry: document.getElementById('errorRetry'),
    anonymous: document.getElementById('anonymous'),
    senderName: document.getElementById('senderName'),
    senderContact: document.getElementById('senderContact'),
    description: document.getElementById('description'),
    detailsToggle: document.getElementById('detailsToggle'),
};

let isUploading = false;
let selectedFiles = [];

// Warn the user if they try to close the tab mid-upload.
window.addEventListener('beforeunload', (e) => {
    if (isUploading) {
        e.preventDefault();
        e.returnValue = 'Your upload is still in progress. Leaving will cancel it.';
        return e.returnValue;
    }
});

// ---------- FILE SELECTION ----------
els.fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    // Defer the reset so iOS Safari can close the photo picker first.
    // Resetting synchronously can prolong the picker dismissal on iOS.
    setTimeout(() => { els.fileInput.value = ''; }, 0);
    addFiles(files);
});

['dragenter', 'dragover'].forEach(evt => {
    els.dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        els.dropzone.classList.add('drag-over');
    });
});

['dragleave', 'drop'].forEach(evt => {
    els.dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        els.dropzone.classList.remove('drag-over');
    });
});

els.dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) {
        addFiles(Array.from(e.dataTransfer.files));
    }
});

function addFiles(files) {
    for (const f of files) {
        // Prevent duplicates by name+size.
        if (!selectedFiles.some(s => s.name === f.name && s.size === f.size)) {
            selectedFiles.push(f);
        }
    }
    renderFileList();
}

function renderFileList() {
    els.fileList.innerHTML = '';
    selectedFiles.forEach((file, idx) => {
        const li = document.createElement('li');
        li.className = 'file-item';
        li.innerHTML = `
            <span class="file-item-name"></span>
            <span class="file-item-size">${formatBytes(file.size)}</span>
            <button class="file-item-remove" aria-label="Remove file" data-idx="${idx}">&times;</button>
        `;
        li.querySelector('.file-item-name').textContent = file.name;
        els.fileList.appendChild(li);
    });
    els.submitBtn.disabled = selectedFiles.length === 0;
}

els.fileList.addEventListener('click', (e) => {
    const btn = e.target.closest('.file-item-remove');
    if (!btn) return;
    selectedFiles.splice(Number(btn.dataset.idx), 1);
    renderFileList();
});

// ---------- ANONYMOUS TOGGLE ----------
els.anonymous.addEventListener('change', () => {
    const body = els.detailsToggle.querySelector('.details-body');
    body.classList.toggle('anon-on', els.anonymous.checked);
    if (els.anonymous.checked) {
        els.senderName.value = '';
        els.senderContact.value = '';
    }
});

// ---------- SUBMIT ----------
els.submitBtn.addEventListener('click', async () => {
    if (!selectedFiles.length) return;

    if (SCRIPT_URL.startsWith('PASTE_')) {
        showError('Upload endpoint is not configured yet. Please contact the site owner.');
        return;
    }

    const meta = {
        senderName: els.anonymous.checked ? '' : els.senderName.value.trim(),
        senderContact: els.anonymous.checked ? '' : els.senderContact.value.trim(),
        description: els.description.value.trim(),
        anonymous: els.anonymous.checked,
        userAgent: navigator.userAgent,
    };

    showScreen('progress');
    isUploading = true;
    resetProgressUI();

    try {
        const totalBytes = selectedFiles.reduce((acc, f) => acc + f.size, 0);
        let uploadedBytes = 0;
        let lastTick = Date.now();
        let lastTickBytes = 0;
        let smoothedRate = 0;

        for (let i = 0; i < selectedFiles.length; i++) {
            const file = selectedFiles[i];
            els.progressFile.textContent = selectedFiles.length > 1
                ? `${file.name}  (${i + 1} / ${selectedFiles.length})`
                : file.name;

            await uploadOneFile(file, meta, (bytesDelta, phase) => {
                uploadedBytes += bytesDelta;

                const pct = totalBytes > 0 ? Math.min(100, (uploadedBytes / totalBytes) * 100) : 0;
                els.progressBar.style.width = pct.toFixed(2) + '%';
                els.progressPercent.textContent = pct.toFixed(0) + '%';

                const now = Date.now();
                const dt = (now - lastTick) / 1000;
                if (dt >= 0.4) {
                    const instant = (uploadedBytes - lastTickBytes) / Math.max(dt, 0.001);
                    smoothedRate = smoothedRate === 0 ? instant : smoothedRate * 0.6 + instant * 0.4;
                    lastTick = now;
                    lastTickBytes = uploadedBytes;
                }

                const rateStr = smoothedRate > 0 ? `${formatBytes(smoothedRate)}/s` : '';
                const etaStr = smoothedRate > 0
                    ? ` · ~${formatDuration((totalBytes - uploadedBytes) / smoothedRate)} remaining`
                    : '';

                els.progressStatus.textContent = phase || (rateStr ? `${rateStr}${etaStr}` : 'Uploading…');
            });
        }

        els.progressBar.style.width = '100%';
        els.progressPercent.textContent = '100%';
        els.progressStatus.textContent = 'Finalizing…';

        isUploading = false;
        showScreen('thankyou');
    } catch (err) {
        console.error(err);
        isUploading = false;
        showError(err?.message || 'Upload failed. Please try again.');
    }
});

function resetProgressUI() {
    els.progressBar.style.width = '0%';
    els.progressPercent.textContent = '0%';
    els.progressFile.textContent = 'Preparing…';
    els.progressStatus.textContent = 'Starting upload…';
}

// ---------- UPLOAD ONE FILE ----------
// Chunks go directly from the browser to Drive's resumable session URL.
// Apps Script is only involved at the start (to open the session) and
// at the end (to write the sidecar file + send the notification email).
async function uploadOneFile(file, meta, onProgress) {
    // Step 1: Ask Apps Script to open a Drive resumable session.
    let startRes;
    try {
        startRes = await postJSON(SCRIPT_URL, {
            action: 'start',
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
        });
    } catch (err) {
        console.error('Start failed:', err);
        throw new Error(`Couldn't start the upload. Please check your connection and try again.`);
    }
    if (!startRes.uploadUrl) {
        console.error('Start error:', startRes.error);
        throw new Error(`Couldn't start the upload. Please try again.`);
    }

    const uploadUrl = startRes.uploadUrl;
    const storedName = startRes.storedName || '';
    const mimeType = file.type || 'application/octet-stream';

    // Step 2: PUT chunks directly to Drive.
    let offset = 0;
    let fileId = null;
    let creditedBytes = 0; // total bytes reported to onProgress so far

    // Helper: report a net delta from creditedBytes up to newCumulative.
    const creditUpTo = (newCumulative) => {
        const delta = newCumulative - creditedBytes;
        if (delta !== 0) {
            onProgress(delta);
            creditedBytes = newCumulative;
        }
    };

    while (offset < file.size && !fileId) {
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const chunkBlob = file.slice(offset, end);

        let succeeded = false;
        let lastErr = null;

        for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
            try {
                const result = await putChunkToDrive(
                    uploadUrl,
                    chunkBlob,
                    offset,
                    end - 1,
                    file.size,
                    mimeType,
                    // Live within-chunk progress.
                    (bytesSentInChunk) => creditUpTo(offset + bytesSentInChunk)
                );

                if (result.done) {
                    // Final chunk accepted; response contains the file metadata.
                    fileId = result.fileId;
                    creditUpTo(file.size);
                } else {
                    // 308 Resume Incomplete — Drive tells us how much it has.
                    creditUpTo(result.nextOffset);
                    offset = result.nextOffset;
                }

                succeeded = true;
                break;
            } catch (err) {
                lastErr = err;
                if (attempt === MAX_CHUNK_RETRIES) break;

                // Roll back any in-flight bytes for this chunk — we don't
                // know how much Drive actually received yet.
                creditUpTo(offset);

                // Ask Drive where it actually is. If the chunk actually
                // completed server-side (common on transient network hiccups),
                // we skip ahead instead of re-sending.
                try {
                    const queried = await queryDriveOffset(uploadUrl, file.size);
                    if (queried.done) {
                        fileId = queried.fileId;
                        creditUpTo(file.size);
                        succeeded = true;
                        break;
                    }
                    offset = queried.nextOffset;
                    creditUpTo(offset);
                } catch (qErr) {
                    // Query failed; fall through to backoff + retry at same offset.
                }

                const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
                onProgress(0, 'Connection issue — reconnecting…');
                await sleep(delay);
            }
        }

        if (!succeeded) {
            console.error('Chunk upload failed:', lastErr);
            throw new Error(`Upload failed on "${file.name}". Please try again.`);
        }

        if (!fileId) offset = Math.max(offset, end);
    }

    if (!fileId) {
        // Drive finished ingesting but we somehow didn't capture the id.
        // Query once more as a safety net.
        try {
            const finalQuery = await queryDriveOffset(uploadUrl, file.size);
            if (finalQuery.done) fileId = finalQuery.fileId;
        } catch { /* ignore */ }
    }
    if (!fileId) {
        throw new Error(`Upload didn't complete for "${file.name}". Please try again.`);
    }

    // Step 3: Finalize — sidecar metadata + email notification.
    onProgress(0, 'Finishing up…');
    let finishRes;
    try {
        finishRes = await postJSON(SCRIPT_URL, {
            action: 'finish',
            fileId: fileId,
            fileName: file.name,
            storedName: storedName,
            ...meta,
        });
    } catch (err) {
        console.error('Finish failed:', err);
        // File is already in Drive; the email/sidecar just didn't land.
        throw new Error(`Upload saved to Drive, but notification failed. Please let Chris know.`);
    }
    if (finishRes.error) {
        console.error('Finish error:', finishRes.error);
        throw new Error(`Upload saved to Drive, but notification failed. Please let Chris know.`);
    }
}

// ---------- POST JSON TO APPS SCRIPT ----------
// Simple-request CORS: POST + Content-Type text/plain, no upload listeners.
// This is critical — adding an xhr.upload event listener would make this a
// non-simple request, triggering a CORS preflight that Apps Script can't
// answer correctly. Don't add one.
function postJSON(url, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
        // 5 minutes per request — plenty for a chunk on slow mobile.
        xhr.timeout = 300000;

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    resolve(JSON.parse(xhr.responseText));
                } catch {
                    reject(new Error('Invalid server response: ' + xhr.responseText.slice(0, 200)));
                }
            } else {
                reject(new Error(`HTTP ${xhr.status} ${xhr.statusText}`));
            }
        };
        xhr.onerror = () => reject(new Error('Network error (connection dropped).'));
        xhr.ontimeout = () => reject(new Error('Request timed out.'));
        xhr.send(body);
    });
}

// ---------- PUT A CHUNK DIRECTLY TO DRIVE ----------
// Resolves with either:
//   { done: true,  fileId: '...' }       // on 200/201 (final chunk)
//   { done: false, nextOffset: number }  // on 308 Resume Incomplete
// Rejects on network error, timeout, or any 4xx/5xx from Drive.
function putChunkToDrive(uploadUrl, chunkBlob, startByte, endByte, totalSize, mimeType, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl, true);
        xhr.setRequestHeader('Content-Range', `bytes ${startByte}-${endByte}/${totalSize}`);
        // Don't set Content-Type on resumable PUTs; the mime type was already
        // declared in the session init. Setting it here is harmless but adds
        // preflight header complexity.
        xhr.timeout = 600000; // 10 minutes per chunk, for slow mobile connections

        if (onProgress) {
            xhr.upload.onprogress = (ev) => {
                if (ev.lengthComputable) onProgress(ev.loaded);
            };
        }

        xhr.onload = () => {
            const status = xhr.status;
            if (status === 200 || status === 201) {
                try {
                    const data = JSON.parse(xhr.responseText);
                    resolve({ done: true, fileId: data.id });
                } catch {
                    reject(new Error('Invalid completion response from Drive.'));
                }
            } else if (status === 308) {
                // Drive accepted so far; Range header tells us how far.
                const rangeHeader = xhr.getResponseHeader('Range');
                let nextOffset = endByte + 1; // assume full chunk if Range not exposed
                if (rangeHeader) {
                    const m = rangeHeader.match(/bytes=0-(\d+)/);
                    if (m) nextOffset = parseInt(m[1], 10) + 1;
                }
                resolve({ done: false, nextOffset: nextOffset });
            } else {
                reject(new Error(`Drive returned ${status}: ${(xhr.responseText || '').slice(0, 200)}`));
            }
        };
        xhr.onerror = () => reject(new Error('Network error during chunk upload.'));
        xhr.ontimeout = () => reject(new Error('Chunk upload timed out.'));
        xhr.send(chunkBlob);
    });
}

// ---------- QUERY DRIVE FOR CURRENT OFFSET ----------
// Used after a failed chunk to ask "how much did you actually receive?"
// so we can skip re-sending bytes Drive already has.
function queryDriveOffset(uploadUrl, totalSize) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl, true);
        xhr.setRequestHeader('Content-Range', `bytes */${totalSize}`);
        xhr.timeout = 60000;

        xhr.onload = () => {
            const status = xhr.status;
            if (status === 200 || status === 201) {
                try {
                    const data = JSON.parse(xhr.responseText);
                    resolve({ done: true, fileId: data.id });
                } catch {
                    reject(new Error('Invalid query response from Drive.'));
                }
            } else if (status === 308) {
                const rangeHeader = xhr.getResponseHeader('Range');
                let nextOffset = 0;
                if (rangeHeader) {
                    const m = rangeHeader.match(/bytes=0-(\d+)/);
                    if (m) nextOffset = parseInt(m[1], 10) + 1;
                }
                resolve({ done: false, nextOffset: nextOffset });
            } else {
                reject(new Error(`Drive status query returned ${status}`));
            }
        };
        xhr.onerror = () => reject(new Error('Network error querying upload status.'));
        xhr.ontimeout = () => reject(new Error('Upload-status query timed out.'));
        xhr.send(); // empty body: this is a status query
    });
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ---------- SCREEN SWITCHING ----------
function showScreen(name) {
    els.uploader.hidden = name !== 'upload';
    els.progressScreen.hidden = name !== 'progress';
    els.thankyouScreen.hidden = name !== 'thankyou';
    els.errorScreen.hidden = name !== 'error';
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showError(msg) {
    els.errorBody.textContent = msg;
    showScreen('error');
}

els.sendAnother.addEventListener('click', resetForm);
els.errorRetry.addEventListener('click', resetForm);

function resetForm() {
    selectedFiles = [];
    renderFileList();
    els.progressBar.style.width = '0%';
    els.description.value = '';
    showScreen('upload');
}

// ---------- HELPERS ----------
function formatBytes(bytes) {
    if (bytes < 1024) return Math.round(bytes) + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function formatDuration(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 60) return Math.max(1, Math.round(seconds)) + 's';
    if (seconds < 3600) {
        const m = Math.floor(seconds / 60);
        const s = Math.round(seconds % 60);
        return `${m}m ${s}s`;
    }
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return `${h}h ${m}m`;
}
