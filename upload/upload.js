// ============================================================
// TIPLINE UPLOAD CLIENT
// All uploads are proxied through Google Apps Script to Drive,
// which eliminates all CORS issues (no direct browser→googleapis.com).
// ============================================================
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbw_xPCXhuU7gMn4MyV1q6FOmWZpNbvuWgWJwrr-zJdaJCG1Bz4I4WfUMFUCdmxugj2E/exec';
// ============================================================

// 3 MB raw chunks. After base64 encoding (~33% overhead) each POST body is ~4 MB.
// Kept small because for most home/mobile internet, the POST upload time (not
// Apps Script overhead) is the dominant per-chunk cost. Smaller chunks = each
// chunk finishes faster, progress feels smoother, and flaky connections recover
// quickly. Must be a multiple of 256 KB per Drive's resumable upload spec.
const CHUNK_SIZE = 3 * 1024 * 1024;
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
// All chunks are POSTed to Apps Script as base64 JSON. Apps Script forwards
// them to Drive's resumable session server-side, so there's no CORS exposure
// as long as each POST remains a "simple request" (no upload listeners).
async function uploadOneFile(file, meta, onProgress) {
    // Step 1: Ask Apps Script to open a server-side resumable Drive session.
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
    if (!startRes.uploadId) {
        console.error('Start error:', startRes.error);
        throw new Error(`Couldn't start the upload. Please try again.`);
    }

    const uploadId = startRes.uploadId;

    // Step 2: Stream chunks to Apps Script, which relays them to Drive.
    let offset = 0;

    while (offset < file.size) {
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const chunkBlob = file.slice(offset, end);

        // Read chunk as base64 once; reused across retries.
        const chunkBase64 = await blobToBase64(chunkBlob);

        let succeeded = false;
        let lastErr = null;
        for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
            try {
                const res = await postJSON(SCRIPT_URL, {
                    action: 'chunk',
                    uploadId: uploadId,
                    offset: offset,
                    dataBase64: chunkBase64,
                });

                if (res.error) throw new Error(res.error);

                // Chunk accepted — credit its full byte count in one go.
                onProgress(end - offset);
                succeeded = true;
                break;
            } catch (err) {
                lastErr = err;
                if (attempt === MAX_CHUNK_RETRIES) break;

                const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
                onProgress(0, 'Connection issue — reconnecting…');
                await sleep(delay);
            }
        }

        if (!succeeded) {
            // Log technical detail for debugging but show a simple message to the user.
            console.error('Chunk upload failed:', lastErr);
            throw new Error(`Upload failed on "${file.name}". Please try again.`);
        }

        offset = end;
    }

    // Step 3: Finalize — sidecar metadata + email notification.
    onProgress(0, 'Finishing up…');
    let finishRes;
    try {
        finishRes = await postJSON(SCRIPT_URL, {
            action: 'finish',
            uploadId: uploadId,
            ...meta,
        });
    } catch (err) {
        console.error('Finish failed:', err);
        throw new Error(`Upload couldn't be finalized. Please try again.`);
    }
    if (finishRes.error) {
        console.error('Finish error:', finishRes.error);
        throw new Error(`Upload couldn't be finalized. Please try again.`);
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
