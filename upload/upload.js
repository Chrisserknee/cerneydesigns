// ============================================================
// TIPLINE UPLOAD CLIENT
// ============================================================
// PASTE YOUR APPS SCRIPT WEB APP URL BELOW
// (ends with /exec, from the Apps Script deployment)
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxKAg7SlmtA_Qipa_GFJ3CfxacNtjy9xmQO76EA5yH8Q4eSZKQGu9GAwZC7WEhS8TYzJQ/exec';
// ============================================================

// 4 MB chunks — Google Drive resumable upload requires chunk size to be a multiple of 256 KB
// (except the final chunk). Smaller chunks = better resilience on flaky mobile networks at
// the cost of slightly more overhead. 4MB is a good sweet spot.
const CHUNK_SIZE = 4 * 1024 * 1024;
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

// Warn users who try to close the tab during an active upload.
window.addEventListener('beforeunload', (e) => {
    if (isUploading) {
        e.preventDefault();
        e.returnValue = 'Your upload is still in progress. Leaving will cancel it.';
        return e.returnValue;
    }
});

let selectedFiles = [];

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
        let smoothedRate = 0; // bytes / sec

        for (let i = 0; i < selectedFiles.length; i++) {
            const file = selectedFiles[i];
            els.progressFile.textContent = `File ${i + 1} of ${selectedFiles.length}: ${file.name}`;

            await uploadOneFile(file, meta, (bytesDelta, phase) => {
                uploadedBytes += bytesDelta;

                const pct = totalBytes > 0 ? Math.min(100, (uploadedBytes / totalBytes) * 100) : 0;
                els.progressBar.style.width = pct.toFixed(2) + '%';
                els.progressPercent.textContent = pct.toFixed(0) + '%';

                // Instantaneous transfer rate (smoothed).
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

        // Final flourish before switching screens.
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
async function uploadOneFile(file, meta, onProgress) {
    // Step 1: Ask Apps Script to open a resumable upload session on Drive.
    // The script returns a signed session URL that lets the browser PUT chunks
    // directly to Google's servers — no OAuth token ever reaches the browser.
    const startRes = await postScript({
        action: 'start',
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
    });

    if (!startRes.uploadUrl) {
        throw new Error(startRes.error || 'Failed to start upload.');
    }

    const uploadUrl = startRes.uploadUrl;

    // Step 2: PUT chunks to the session URL, with byte-level progress + retry/resume.
    let offset = 0;
    let reportedBytes = 0; // bytes credited to onProgress so far for THIS file

    const credit = (toByte) => {
        const delta = toByte - reportedBytes;
        if (delta > 0) {
            onProgress(delta);
            reportedBytes = toByte;
        }
    };

    while (offset < file.size) {
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const chunk = file.slice(offset, end);

        let succeeded = false;
        for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
            try {
                await putChunk(
                    uploadUrl,
                    chunk,
                    offset,
                    end - 1,
                    file.size,
                    // Byte-level progress inside the chunk: credit bytes as they leave the browser.
                    (bytesSentInChunk) => {
                        credit(offset + bytesSentInChunk);
                    }
                );
                credit(end); // ensure full chunk is credited once complete
                succeeded = true;
                break;
            } catch (err) {
                if (attempt === MAX_CHUNK_RETRIES) {
                    throw new Error(
                        `Upload failed on "${file.name}" at ${formatBytes(offset)} / ${formatBytes(file.size)} ` +
                        `after ${MAX_CHUNK_RETRIES} retries. ${err.message || err}`
                    );
                }
                // Roll back the global counter for any bytes optimistically credited from this failed chunk.
                const rollback = reportedBytes - offset;
                if (rollback > 0) {
                    onProgress(-rollback);
                    reportedBytes = offset;
                }
                onProgress(0, `Network hiccup — retrying in ${Math.round(
                    RETRY_BASE_DELAY_MS * Math.pow(2, attempt) / 1000
                )}s (${attempt + 1}/${MAX_CHUNK_RETRIES})…`);

                await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt));

                // Ask Drive what it actually has so we skip already-received bytes.
                try {
                    const serverOffset = await queryUploadOffset(uploadUrl, file.size);
                    if (serverOffset !== null && serverOffset > offset) {
                        credit(serverOffset);
                        offset = serverOffset;
                        succeeded = true;
                        break;
                    }
                } catch {
                    // ignore and retry
                }
            }
        }

        if (!succeeded) break; // shouldn't happen, throws above
        offset = Math.max(offset, end);
    }

    // Step 3: Tell the script upload finished, so it can attach metadata.
    // The Drive file ID isn't strictly needed — the script looks up by name + recent time.
    await postScript({
        action: 'finish',
        fileName: file.name,
        ...meta,
    });
}

// ---------- APPS SCRIPT CALL ----------
// text/plain avoids CORS preflight — Apps Script deployments don't handle OPTIONS requests.
async function postScript(payload) {
    const res = await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'follow',
    });
    if (!res.ok) {
        throw new Error(`Server error ${res.status}`);
    }
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        throw new Error('Invalid server response: ' + text.slice(0, 200));
    }
}

// ---------- CHUNK PUT (to Drive resumable session) ----------
function putChunk(uploadUrl, chunk, startByte, endByte, totalSize, onChunkProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl, true);
        xhr.setRequestHeader('Content-Range', `bytes ${startByte}-${endByte}/${totalSize}`);
        // Give slow connections plenty of time before we consider it dead.
        xhr.timeout = 180000;

        if (onChunkProgress) {
            xhr.upload.onprogress = (ev) => {
                if (ev.lengthComputable) {
                    onChunkProgress(ev.loaded);
                }
            };
        }

        xhr.onload = () => {
            // 200/201 = upload complete. 308 = chunk received, continue.
            if (xhr.status === 200 || xhr.status === 201 || xhr.status === 308) {
                resolve();
            } else {
                reject(new Error(`HTTP ${xhr.status} ${xhr.statusText}`));
            }
        };
        xhr.onerror = () => reject(new Error('Network error (connection dropped).'));
        xhr.ontimeout = () => reject(new Error('Chunk timed out.'));
        xhr.send(chunk);
    });
}

// ---------- QUERY UPLOAD OFFSET ----------
// Per Drive resumable protocol: PUT with Content-Range: bytes *\/TOTAL and empty body
// returns 308 with a Range header like "bytes=0-4194303" showing what Drive already has.
// Returns the next byte to send, or null if the query failed.
function queryUploadOffset(uploadUrl, totalSize) {
    return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl, true);
        xhr.setRequestHeader('Content-Range', `bytes */${totalSize}`);
        xhr.timeout = 30000;

        xhr.onload = () => {
            if (xhr.status === 200 || xhr.status === 201) {
                resolve(totalSize); // whole file already uploaded
                return;
            }
            if (xhr.status === 308) {
                const range = xhr.getResponseHeader('Range');
                if (!range) return resolve(0);
                const m = range.match(/bytes=0-(\d+)/);
                if (m) return resolve(Number(m[1]) + 1);
                return resolve(0);
            }
            resolve(null);
        };
        xhr.onerror = () => resolve(null);
        xhr.ontimeout = () => resolve(null);
        xhr.send('');
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
