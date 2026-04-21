// ============================================================
// TIPLINE UPLOAD CLIENT — Firebase Storage
// Direct browser → Firebase Storage via the official SDK.
// The SDK handles resumable uploads, automatic retries, and
// backoff internally, so there's no custom chunking layer here.
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
    getStorage,
    ref,
    uploadBytesResumable,
    uploadBytes,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js";

const firebaseConfig = {
    apiKey: "AIzaSyCx67HjmZs9C1BtqqkoKTY8a7f11voCnSc",
    authDomain: "tip-line-8c2d7.firebaseapp.com",
    projectId: "tip-line-8c2d7",
    storageBucket: "tip-line-8c2d7.firebasestorage.app",
    messagingSenderId: "218726736554",
    appId: "1:218726736554:web:ccb0d588014b4e61d6e6d3",
};

const app = initializeApp(firebaseConfig);
const storage = getStorage(app);

// Per-file hard cap. Storage rules enforce the same limit server-side.
const MAX_FILE_BYTES = 500 * 1024 * 1024; // 500 MB

// How many files to upload in parallel. Firebase Storage comfortably handles
// multiple concurrent streams; 2 is a safe sweet spot for most connections.
const CONCURRENCY = 2;

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
    const rejected = [];
    for (const f of files) {
        if (f.size > MAX_FILE_BYTES) {
            rejected.push(f.name);
            continue;
        }
        if (!selectedFiles.some(s => s.name === f.name && s.size === f.size)) {
            selectedFiles.push(f);
        }
    }
    if (rejected.length) {
        alert(
            `The following file${rejected.length > 1 ? 's are' : ' is'} too large ` +
            `(max ${formatBytes(MAX_FILE_BYTES)}):\n\n` + rejected.join('\n')
        );
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
        const displayName = file.name.length > 60 ? file.name.slice(0, 57) + '…' : file.name;
        li.querySelector('.file-item-name').textContent = displayName;
        li.querySelector('.file-item-name').title = file.name;
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

    const meta = {
        senderName: els.anonymous.checked ? '' : els.senderName.value.trim(),
        senderContact: els.anonymous.checked ? '' : els.senderContact.value.trim(),
        description: els.description.value.trim(),
        anonymous: els.anonymous.checked,
        // For anonymous submissions, don't leak the user-agent string — it
        // partially de-anonymizes the sender (browser, OS, device model).
        userAgent: els.anonymous.checked ? '' : navigator.userAgent,
    };

    // Unique folder per submission: sortable UTC timestamp + short random tag.
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}_${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 8);
    const sessionFolder = `tips/${ts}_${rand}`;

    showScreen('progress');
    isUploading = true;
    resetProgressUI();

    try {
        const totalBytes = selectedFiles.reduce((acc, f) => acc + f.size, 0);

        // Per-file running byte counts from the SDK's progress callbacks.
        const progresses = new Array(selectedFiles.length).fill(0);

        let filesCompleted = 0;
        let lastTick = Date.now();
        let lastTickBytes = 0;
        let smoothedRate = 0;

        const updateFileLabel = () => {
            if (selectedFiles.length <= 1) {
                els.progressFile.textContent = selectedFiles[0]?.name || '';
            } else {
                els.progressFile.textContent = `${filesCompleted} of ${selectedFiles.length} files complete`;
            }
        };
        updateFileLabel();

        const updateProgressUI = (phase) => {
            const uploadedBytes = progresses.reduce((s, v) => s + v, 0);
            const pct = totalBytes > 0 ? Math.min(100, (uploadedBytes / totalBytes) * 100) : 0;
            els.progressBar.style.width = pct.toFixed(2) + '%';
            els.progressPercent.textContent = pct.toFixed(0) + '%';

            const tNow = Date.now();
            const dt = (tNow - lastTick) / 1000;
            if (dt >= 0.4) {
                const instant = (uploadedBytes - lastTickBytes) / Math.max(dt, 0.001);
                smoothedRate = smoothedRate === 0 ? instant : smoothedRate * 0.6 + instant * 0.4;
                lastTick = tNow;
                lastTickBytes = uploadedBytes;
            }

            const rateStr = smoothedRate > 0 ? `${formatBytes(smoothedRate)}/s` : '';
            const etaStr = smoothedRate > 0
                ? ` · ~${formatDuration((totalBytes - uploadedBytes) / smoothedRate)} remaining`
                : '';

            els.progressStatus.textContent = phase || (rateStr ? `${rateStr}${etaStr}` : 'Uploading…');
        };

        // Custom metadata attached to every uploaded file.
        const customMetadata = { anonymous: String(meta.anonymous) };
        if (!meta.anonymous) {
            if (meta.senderName) customMetadata.senderName = meta.senderName.slice(0, 200);
            if (meta.senderContact) customMetadata.senderContact = meta.senderContact.slice(0, 200);
            if (meta.userAgent) customMetadata.userAgent = meta.userAgent.slice(0, 500);
        }
        if (meta.description) customMetadata.description = meta.description.slice(0, 1000);

        const uploadOneFile = (file, idx) => new Promise((resolve, reject) => {
            // Strip any path separators from the filename (defense in depth).
            const safeName = file.name.replace(/[\\/]/g, '_');
            const storageRef = ref(storage, `${sessionFolder}/${safeName}`);

            const task = uploadBytesResumable(storageRef, file, {
                contentType: file.type || 'application/octet-stream',
                customMetadata: customMetadata,
            });

            task.on(
                'state_changed',
                (snap) => {
                    progresses[idx] = snap.bytesTransferred;
                    updateProgressUI();
                },
                (error) => {
                    console.error(`Upload failed for ${file.name}:`, error);
                    reject(new Error(`Upload failed on "${file.name}". Please try again.`));
                },
                () => {
                    filesCompleted++;
                    // Ensure this file's bar contribution reflects full size.
                    progresses[idx] = file.size;
                    updateFileLabel();
                    updateProgressUI();
                    resolve();
                }
            );
        });

        // Parallel upload workers. Each pulls the next unclaimed file index.
        let nextIdx = 0;
        const worker = async () => {
            while (true) {
                const i = nextIdx++;
                if (i >= selectedFiles.length) break;
                await uploadOneFile(selectedFiles[i], i);
            }
        };
        const workers = [];
        const concurrency = Math.min(CONCURRENCY, selectedFiles.length);
        for (let w = 0; w < concurrency; w++) workers.push(worker());
        await Promise.all(workers);

        // Sidecar JSON written last — its presence signals a complete submission.
        updateProgressUI('Finishing up…');
        const submission = {
            submittedAt: new Date().toISOString(),
            fileCount: selectedFiles.length,
            totalBytes,
            files: selectedFiles.map(f => ({ name: f.name, size: f.size, type: f.type })),
            anonymous: meta.anonymous,
            ...(meta.anonymous ? {} : {
                senderName: meta.senderName,
                senderContact: meta.senderContact,
                userAgent: meta.userAgent,
            }),
            description: meta.description,
        };
        const infoRef = ref(storage, `${sessionFolder}/_submission.json`);
        const infoBlob = new Blob([JSON.stringify(submission, null, 2)], { type: 'application/json' });
        await uploadBytes(infoRef, infoBlob, { contentType: 'application/json' });

        els.progressBar.style.width = '100%';
        els.progressPercent.textContent = '100%';
        els.progressStatus.textContent = 'Done';

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
