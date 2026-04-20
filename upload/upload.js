// ============================================================
// TIPLINE UPLOAD CLIENT
// ============================================================
// PASTE YOUR APPS SCRIPT WEB APP URL BELOW
// (ends with /exec, from the Apps Script deployment)
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxKAg7SlmtA_Qipa_GFJ3CfxacNtjy9xmQO76EA5yH8Q4eSZKQGu9GAwZC7WEhS8TYzJQ/exec';
// ============================================================

// 8 MB chunks — large enough to be fast, small enough to resume quickly on flaky mobile networks.
// Google Drive resumable upload requires chunks to be multiples of 256 KB (except the final chunk).
const CHUNK_SIZE = 8 * 1024 * 1024;

const els = {
    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('fileInput'),
    fileList: document.getElementById('fileList'),
    submitBtn: document.getElementById('submitBtn'),
    uploader: document.getElementById('uploader'),
    progressScreen: document.getElementById('progressScreen'),
    progressBar: document.getElementById('progressBar'),
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

    try {
        const totalBytes = selectedFiles.reduce((acc, f) => acc + f.size, 0);
        let uploadedBytes = 0;

        for (let i = 0; i < selectedFiles.length; i++) {
            const file = selectedFiles[i];
            const fileLabel = `${i + 1} of ${selectedFiles.length}`;
            els.progressStatus.textContent = `File ${fileLabel} — ${file.name}`;

            await uploadOneFile(file, meta, (chunkBytes) => {
                uploadedBytes += chunkBytes;
                const pct = Math.min(100, (uploadedBytes / totalBytes) * 100);
                els.progressBar.style.width = pct.toFixed(1) + '%';
                els.progressStatus.textContent =
                    `File ${fileLabel} — ${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)} (${pct.toFixed(0)}%)`;
            });
        }

        showScreen('thankyou');
    } catch (err) {
        console.error(err);
        showError(err?.message || 'Upload failed. Please try again.');
    }
});

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

    // Step 2: PUT chunks to the session URL.
    let offset = 0;
    while (offset < file.size) {
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const chunk = file.slice(offset, end);
        const isLast = end === file.size;

        await putChunk(uploadUrl, chunk, offset, end - 1, file.size);
        onProgress(chunk.size);
        offset = end;

        if (isLast) break;
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
function putChunk(uploadUrl, chunk, startByte, endByte, totalSize) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl, true);
        xhr.setRequestHeader('Content-Range', `bytes ${startByte}-${endByte}/${totalSize}`);

        xhr.onload = () => {
            // 200/201 = upload complete. 308 = chunk received, continue.
            if (xhr.status === 200 || xhr.status === 201 || xhr.status === 308) {
                resolve();
            } else {
                reject(new Error(`Chunk upload failed: ${xhr.status} ${xhr.statusText}`));
            }
        };
        xhr.onerror = () => reject(new Error('Network error during chunk upload.'));
        xhr.ontimeout = () => reject(new Error('Upload timed out.'));
        xhr.send(chunk);
    });
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
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
