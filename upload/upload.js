// ============================================================
// TIPLINE UPLOAD CLIENT
// All uploads are proxied through Google Apps Script to Drive,
// which eliminates all CORS issues (no direct browser→googleapis.com).
// ============================================================
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbw_xPCXhuU7gMn4MyV1q6FOmWZpNbvuWgWJwrr-zJdaJCG1Bz4I4WfUMFUCdmxugj2E/exec';
// ============================================================

// 5 MB raw chunks. After base64 encoding (~33% overhead) each POST body is ~7 MB
// — well under the Apps Script 50 MB limit with headroom for JSON keys/metadata.
// Must be a multiple of 256 KB per Drive's resumable upload spec.
const CHUNK_SIZE = 5 * 1024 * 1024;
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
    progressTotals: document.getElementById('progressTotals'),
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
    addFiles(Array.from(e.target.files));
    els.fileInput.value = '';
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
            els.progressFile.textContent = `File ${i + 1} of ${selectedFiles.length}: ${file.name}`;

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
                els.progressTotals.textContent = `${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)}`;
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
    els.progressTotals.textContent = '';
}

// ---------- UPLOAD ONE FILE ----------
// All chunks are POSTed to Apps Script as base64 JSON. Apps Script forwards
// them to Drive's resumable session server-side, so there's no CORS exposure.
async function uploadOneFile(file, meta, onProgress) {
    // Step 1: Ask Apps Script to open a server-side resumable Drive session.
    const startRes = await postJSON(SCRIPT_URL, {
        action: 'start',
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
    });

    if (!startRes.uploadId) {
        throw new Error(startRes.error || 'Failed to start upload.');
    }

    const uploadId = startRes.uploadId;

    // Step 2: Stream chunks to Apps Script, which relays them to Drive.
    let offset = 0;
    let reportedBytes = 0;

    const credit = (toByte) => {
        const delta = toByte - reportedBytes;
        if (delta !== 0) {
            onProgress(delta);
            reportedBytes = toByte;
        }
    };

    while (offset < file.size) {
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const chunkBlob = file.slice(offset, end);
        const chunkSize = end - offset;

        // Read chunk as base64 once (reused across retries if needed).
        const chunkBase64 = await blobToBase64(chunkBlob);

        let succeeded = false;
        for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
            try {
                const res = await postJSON(
                    SCRIPT_URL,
                    {
                        action: 'chunk',
                        uploadId: uploadId,
                        offset: offset,
                        dataBase64: chunkBase64,
                    },
                    // Byte-level progress: credit bytes as they leave the browser.
                    (bytesSent, totalToSend) => {
                        if (totalToSend > 0) {
                            const frac = Math.min(1, bytesSent / totalToSend);
                            // Credit up to (but not past) the end of this chunk.
                            credit(offset + Math.floor(chunkSize * frac));
                        }
                    }
                );

                if (res.error) throw new Error(res.error);

                credit(end);
                succeeded = true;
                break;
            } catch (err) {
                if (attempt === MAX_CHUNK_RETRIES) {
                    throw new Error(
                        `Upload failed on "${file.name}" at ${formatBytes(offset)} / ${formatBytes(file.size)} ` +
                        `after ${MAX_CHUNK_RETRIES} retries. ${err.message || err}`
                    );
                }

                // Roll back any in-flight progress for this chunk.
                const rollback = reportedBytes - offset;
                if (rollback > 0) {
                    onProgress(-rollback);
                    reportedBytes = offset;
                }

                const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
                onProgress(0, `Network hiccup — retrying in ${Math.round(delay / 1000)}s (${attempt + 1}/${MAX_CHUNK_RETRIES})…`);
                await sleep(delay);
            }
        }

        if (!succeeded) break; // unreachable; MAX_CHUNK_RETRIES exhausted throws
        offset = end;
    }

    // Step 3: Finalize — sidecar metadata + email notification.
    const finishRes = await postJSON(SCRIPT_URL, {
        action: 'finish',
        uploadId: uploadId,
        ...meta,
    });
    if (finishRes.error) throw new Error(finishRes.error);
}

// ---------- POST JSON TO APPS SCRIPT ----------
// Uses XHR (not fetch) so we can get upload progress events.
// Content-Type text/plain avoids the CORS preflight that Apps Script can't handle.
function postJSON(url, payload, onUploadProgress) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
        // 5 minutes per chunk — plenty for a 5MB chunk on slow mobile.
        xhr.timeout = 300000;

        if (onUploadProgress) {
            xhr.upload.onprogress = (ev) => {
                if (ev.lengthComputable) onUploadProgress(ev.loaded, ev.total);
            };
        }

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

// ---------- BLOB → BASE64 ----------
// Reads a File/Blob slice and returns the raw base64 payload (no data URL prefix).
function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result;
            const comma = dataUrl.indexOf(',');
            resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
        };
        reader.onerror = () => reject(new Error('Failed to read file chunk.'));
        reader.readAsDataURL(blob);
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
