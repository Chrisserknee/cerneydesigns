import { authorizeUpload } from "/upload/admission.js?v=20261004-guard";
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
const MAX_TOTAL_BYTES = 750 * 1024 * 1024; // 750 MB per submission
const MAX_FILES_PER_SUBMISSION = 10;
const ALLOWED_CONTENT_TYPES = new Set([
    'application/pdf', 'image/avif', 'image/bmp', 'image/gif', 'image/heic',
    'image/heif', 'image/jpeg', 'image/png', 'image/tiff', 'image/webp',
    'video/3gpp', 'video/3gpp2', 'video/mp4', 'video/mpeg', 'video/quicktime',
    'video/webm', 'video/x-m4v', 'video/x-msvideo',
]);

// How many files to upload in parallel. Firebase Storage comfortably handles
// multiple concurrent streams; 2 is a safe sweet spot for most connections.
const CONCURRENCY = 2;

const els = {
    tipIntro: document.getElementById('tipIntro'),
    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('fileInput'),
    fileList: document.getElementById('fileList'),
    selectionNotice: document.getElementById('selectionNotice'),
    progressTitle: document.getElementById('progressTitle'),
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
    detailsDialog: document.getElementById('detailsDialog'),
    detailsForm: document.getElementById('detailsForm'),
    identityForm: document.getElementById('identityForm'),
    detailsTitle: document.getElementById('detailsTitle'),
    detailsIntro: document.getElementById('detailsIntro'),
    detailsStepLabel: document.getElementById('detailsStepLabel'),
    detailsBack: document.getElementById('detailsBack'),
    skipDetails: document.getElementById('skipDetails'),
    whatHappened: document.getElementById('whatHappened'),
    timing: document.getElementById('timing'),
    location: document.getElementById('location'),
    keepAnonymous: document.getElementById('keepAnonymous'),
    useName: document.getElementById('useName'),
    nameFields: document.getElementById('nameFields'),
    senderName: document.getElementById('senderName'),
    senderContact: document.getElementById('senderContact'),
};

let isUploading = false;
let selectedFiles = [];
let activeUploadTasks = new Set();
let pendingUpload = null;
let selectionPending = false;
let fileStatusLabels = [];

// Warn the user if they try to close the tab mid-upload.
window.addEventListener('beforeunload', (e) => {
    if (isUploading && (!pendingUpload?.sent || resolveDetails === null)) {
        e.preventDefault();
        e.returnValue = pendingUpload?.sent ? 'Your tip was sent, but extra details are still saving.' : 'Your upload is still in progress. Leaving will cancel it.';
        return e.returnValue;
    }
});

// ---------- FILE SELECTION ----------
// Do not read/decode video bytes or build thumbnails here. Native pickers
// prepare media before change fires; a page cannot dismiss that system dialog.
els.fileInput.addEventListener('change', (e) => receiveSelection(Array.from(e.target.files || [])));
els.fileInput.addEventListener('cancel', () => { els.dropzone.focus(); });
els.dropzone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
});
function receiveSelection(files) {
    if (isUploading || selectionPending || !files.length) return;
    selectionPending = true;
    // Return control to the browser before changing screens or starting streams.
    setTimeout(() => {
        els.fileInput.value = '';
        const accepted = addFiles(files);
        selectionPending = false;
        if (accepted) void startUpload();
    }, 0);
}

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
        receiveSelection(Array.from(e.dataTransfer.files));
    }
});

function addFiles(files) {
    if (isUploading) return false;
    const rejected = [];
    const batch = [];
    for (const f of files) {
        if (!f.size) {
            rejected.push(`${f.name} (empty file)`);
            continue;
        }
        if (f.size > MAX_FILE_BYTES) {
            rejected.push(`${f.name} (too large)`);
            continue;
        }
        if (!getAllowedContentType(f)) {
            rejected.push(`${f.name} (unsupported file type)`);
            continue;
        }
        if (batch.length >= MAX_FILES_PER_SUBMISSION) {
            rejected.push(`${f.name} (too many files)`);
            continue;
        }
        const nextTotal = batch.reduce((sum, file) => sum + file.size, 0) + f.size;
        if (nextTotal > MAX_TOTAL_BYTES) {
            rejected.push(`${f.name} (submission total too large)`);
            continue;
        }
        if (!batch.some(s => s.name === f.name && s.size === f.size && s.lastModified === f.lastModified)) batch.push(f);
    }
    els.selectionNotice.hidden = rejected.length === 0;
    if (rejected.length) {
        // Never silently send part of a selection or block picker dismissal with alert().
        els.selectionNotice.textContent = 'Nothing has been sent from this selection. Please choose fewer or smaller files.\n\n' + rejected.join('\n');
        els.selectionNotice.focus();
        return false;
    }
    selectedFiles = batch;
    pendingUpload = null;
    renderFileList();
    return selectedFiles.length > 0;
}

function renderFileList() {
    els.fileList.replaceChildren();
    fileStatusLabels = [];
    selectedFiles.forEach((file, idx) => {
        const li = document.createElement('li');
        li.className = 'file-item';

        const displayName = file.name.length > 60 ? file.name.slice(0, 57) + '…' : file.name;
        const name = document.createElement('span');
        name.className = 'file-item-name';
        name.textContent = displayName;
        name.title = file.name;

        const size = document.createElement('span');
        size.className = 'file-item-size';
        size.textContent = formatBytes(file.size);

        const status = document.createElement('span');
        status.className = 'file-item-status';
        status.textContent = 'Waiting';
        fileStatusLabels.push(status);
        li.append(name, size, status);
        els.fileList.appendChild(li);
    });
}

// ---------- POST-UPLOAD DETAILS ----------
let resolveDetails = null;
function showDetailsStep(identity) {
    els.detailsForm.hidden = identity;
    els.identityForm.hidden = !identity;
    els.detailsStepLabel.textContent = `Tip sent · Optional step ${identity ? 2 : 1} of 2`;
    els.detailsTitle.textContent = identity ? 'Can we use your name in our report?' : 'Help Chris understand your tip';
    els.detailsIntro.textContent = identity
        ? 'You choose. Your name will only be included if you give permission below.'
        : 'Your media tip has already been sent to Chris. Add what happened, when, and where, with as many details as you can. This information will be added to the same tip.';
    els.detailsDialog.scrollTop = 0;
    els.detailsTitle.focus();
}
function updateNameChoice() {
    const named = els.useName.checked;
    els.nameFields.hidden = !named;
    els.senderName.disabled = !named;
    els.senderName.required = named;
    els.senderContact.disabled = !named;
    if (!named) {
        els.senderName.value = '';
        els.senderContact.value = '';
    }
    els.senderName.setCustomValidity('');
}
function finishDetails(skip = false) {
    if (!resolveDetails) return;
    const anonymous = skip || !els.useName.checked;
    const whatHappened = skip ? '' : els.whatHappened.value.trim().slice(0, 2000);
    const timing = skip ? '' : els.timing.value.trim().slice(0, 300);
    const location = skip ? '' : els.location.value.trim().slice(0, 300);
    const meta = {
        anonymous,
        nameUsageConsent: anonymous ? 'anonymous' : 'use_name',
        detailsStatus: skip ? 'skipped' : 'provided',
        senderName: anonymous ? '' : els.senderName.value.trim().slice(0, 180),
        senderContact: anonymous ? '' : els.senderContact.value.trim().slice(0, 220),
        whatHappened, timing, location,
        description: [whatHappened, timing && `When: ${timing}`, location && `Where: ${location}`].filter(Boolean).join('\n\n'),
    };
    const resolve = resolveDetails;
    resolveDetails = null;
    els.detailsDialog.close();
    document.body.classList.remove('tip-dialog-open');
    resolve(meta);
}
function collectDetails() {
    return new Promise(resolve => {
        resolveDetails = resolve;
        showDetailsStep(false);
        document.body.classList.add('tip-dialog-open');
        els.detailsDialog.showModal();
        els.detailsTitle.focus();
    });
}
els.detailsForm.addEventListener('submit', e => { e.preventDefault(); showDetailsStep(true); });
els.detailsBack.addEventListener('click', () => showDetailsStep(false));
els.useName.addEventListener('change', updateNameChoice);
els.keepAnonymous.addEventListener('change', updateNameChoice);
els.senderName.addEventListener('input', () => els.senderName.setCustomValidity(''));
els.identityForm.addEventListener('submit', e => {
    e.preventDefault();
    if (els.useName.checked && !els.senderName.value.trim()) els.senderName.setCustomValidity('Enter the name you want us to use, or choose anonymous.');
    if (!els.identityForm.reportValidity()) return;
    finishDetails();
});
els.skipDetails.addEventListener('click', () => finishDetails(true));
// Escape takes the same privacy-preserving path as the visible skip button.
els.detailsDialog.addEventListener('cancel', e => { e.preventDefault(); finishDetails(true); });

// ---------- AUTOMATIC UPLOAD ----------
async function startUpload() {
    if (isUploading || !selectedFiles.length) return;

    // Unique folder per submission: sortable UTC timestamp + cryptographic tag.
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}_${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}`;
    const rand = createRandomTag();
    // Keep successful files when retrying this submission in the same tab.
    pendingUpload ||= { folder: `tips/${ts}_${rand}`, completed: new Set() };
    const sessionFolder = pendingUpload.folder;

    isUploading = true;
    els.fileInput.disabled = true;
    resetProgressUI();
    showScreen('progress');
    els.progressTitle.focus();

    try {
        // Show the file cards and initial progress before any SDK work begins.
        await new Promise(resolve => setTimeout(resolve, 0));
        const totalBytes = selectedFiles.reduce((acc, f) => acc + f.size, 0);

        // Per-file running byte counts from the SDK's progress callbacks.
        const progresses = selectedFiles.map((file, index) => pendingUpload.completed.has(index) ? file.size : 0);

        let filesCompleted = pendingUpload.completed.size;
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
        fileStatusLabels.forEach((label, i) => { label.textContent = pendingUpload.completed.has(i) ? 'Uploaded' : 'Waiting'; });

        const updateProgressUI = (phase) => {
            const uploadedBytes = progresses.reduce((s, v) => s + v, 0);
            const pct = totalBytes > 0 ? Math.min(99, (uploadedBytes / totalBytes) * 100) : 0;
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

        // Name permission is collected after upload. Keep media metadata free of
        // identity; the final manifest is authoritative for attribution and context.
        const customMetadata = { anonymous: 'true' };

        const storedNames = selectedFiles.map((file, idx) =>
            `${String(idx + 1).padStart(2, '0')}_${safeName(file.name)}`
        );
        const grantFiles = selectedFiles.map((file,idx)=>({name:storedNames[idx],size:file.size,type:getAllowedContentType(file)}));
        await authorizeUpload(app,sessionFolder,grantFiles);
        let uploadAborted = false;
        activeUploadTasks = new Set();

        const cancelActiveUploads = () => {
            uploadAborted = true;
            for (const task of activeUploadTasks) {
                task.cancel();
            }
        };

        const uploadOneFile = (file, idx) => new Promise((resolve, reject) => {
            fileStatusLabels[idx].textContent = 'Uploading…';
            const storageRef = ref(storage, `${sessionFolder}/${storedNames[idx]}`);
            const contentType = getAllowedContentType(file);

            const task = uploadBytesResumable(storageRef, file, {
                contentType,
                customMetadata: customMetadata,
            });
            activeUploadTasks.add(task);

            task.on(
                'state_changed',
                (snap) => {
                    progresses[idx] = snap.bytesTransferred;
                    fileStatusLabels[idx].textContent = `Uploading · ${Math.min(99, Math.floor(snap.bytesTransferred / file.size * 100))}%`;
                    updateProgressUI();
                },
                (error) => {
                    activeUploadTasks.delete(task);
                    fileStatusLabels[idx].textContent = 'Paused';
                    if (uploadAborted && error?.code === 'storage/canceled') {
                        reject(error);
                        return;
                    }
                    console.error(`Upload failed for ${file.name}:`, error);
                    cancelActiveUploads();
                    reject(new Error(`Upload paused on "${file.name}". Keep this page open and retry; completed files will be kept. ${navigator.onLine === false ? "Reconnect to the internet first." : "Keep your screen on while uploading."}`));
                },
                () => {
                    activeUploadTasks.delete(task);
                    pendingUpload.completed.add(idx);
                    fileStatusLabels[idx].textContent = 'Uploaded';
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
            while (!uploadAborted) {
                const i = nextIdx++;
                if (i >= selectedFiles.length) break;
                if (pendingUpload.completed.has(i)) continue;
                await uploadOneFile(selectedFiles[i], i);
            }
        };
        const workers = [];
        const concurrency = Math.min(CONCURRENCY, selectedFiles.length);
        for (let w = 0; w < concurrency; w++) workers.push(worker());
        const outcomes = await Promise.allSettled(workers);
        const failure = outcomes.find(outcome => outcome.status === 'rejected');
        if (failure) throw failure.reason;

        // Publish the complete media manifest BEFORE asking for optional context.
        // This immutable manifest is the tip identity used by alerts, Drive and Claude.
        if (!pendingUpload.contextToken) {
            pendingUpload.contextToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pendingUpload.contextToken));
            pendingUpload.contextKeyHash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
        }

        // All media is uploaded; optional details never delay discovery.
        updateProgressUI('Finishing up…');
        const submission = {
            submittedAt: new Date().toISOString(),
            fileCount: selectedFiles.length,
            totalBytes,
            files: selectedFiles.map((f, idx) => ({
                name: f.name,
                storedName: storedNames[idx],
                size: f.size,
                type: getAllowedContentType(f),
            })),
            anonymous: true,
            nameUsageConsent: 'anonymous',
            detailsStatus: 'pending',
            contextKeyHash: pendingUpload.contextKeyHash,
        };
        if (!pendingUpload.sent) {
            const infoRef = ref(storage, `${sessionFolder}/_submission.json`);
            const infoBlob = new Blob([JSON.stringify(submission, null, 2)], { type: 'application/json' });
            try {
                await uploadBytes(infoRef, infoBlob, {
                    contentType: 'application/json', customMetadata: { anonymous: 'true' },
                });
                pendingUpload.sent = true;
            } catch (error) {
                console.error('Submission finalization failed', error?.code);
                throw new Error('Your files finished uploading, but we could not finalize your tip. Please retry without closing this tab; completed files will not upload again.');
            }
        }
        updateProgressUI('Your tip has been sent. Extra details are optional.');
        els.progressTitle.textContent = 'Your Tip Is Sent';
        els.progressBar.style.width = '100%';
        els.progressPercent.textContent = '100%';
        pendingUpload.meta ||= await collectDetails();
        const meta = pendingUpload.meta;
        if (meta.detailsStatus === 'provided') {
            updateProgressUI('Tip sent. Adding your details to it…');
            const context = {
                contextToken: pendingUpload.contextToken,
                anonymous: meta.anonymous, nameUsageConsent: meta.nameUsageConsent,
                detailsStatus: 'provided', whatHappened: meta.whatHappened,
                timing: meta.timing, location: meta.location,
                ...(meta.anonymous ? {} : { senderName: meta.senderName, senderContact: meta.senderContact }),
            };
            try {
                await authorizeUpload(app,sessionFolder,grantFiles);
                await uploadBytes(ref(storage, `${sessionFolder}/_context.json`),
                    new Blob([JSON.stringify(context)], { type: 'application/json' }),
                    { contentType: 'application/json', customMetadata: { anonymous: String(meta.anonymous) } });
            } catch (error) {
                console.error('Optional context upload failed', error?.code);
                throw new Error('Your media tip was already sent. Only the extra details could not be saved. Keep this tab open and retry to add them to the same tip; your media will not upload again.');
            }
        }

        els.progressBar.style.width = '100%';
        els.progressPercent.textContent = '100%';
        els.progressStatus.textContent = 'Done';

        isUploading = false;
        els.fileInput.disabled = false;
        activeUploadTasks.clear();
        pendingUpload = null;
        showScreen('thankyou');
    } catch (err) {
        console.error(err);
        isUploading = false;
        els.fileInput.disabled = false;
        activeUploadTasks.clear();
        resolveDetails = null;
        if (els.detailsDialog.open) els.detailsDialog.close();
        document.body.classList.remove('tip-dialog-open');
        showError(err?.message || 'Upload failed. Please try again.');
    }
}

function resetProgressUI() {
    els.progressTitle.textContent = 'Uploading Your Tip';
    els.progressBar.style.width = '0%';
    els.progressPercent.textContent = '0%';
    els.progressFile.textContent = 'Preparing…';
    els.progressStatus.textContent = 'Starting upload…';
}

// ---------- SCREEN SWITCHING ----------
function showScreen(name) {
    els.tipIntro.hidden = name !== 'upload';
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
els.errorRetry.addEventListener('click', () => { void startUpload(); });

function resetForm() {
    pendingUpload = null;
    els.selectionNotice.hidden = true;
    els.selectionNotice.textContent = '';
    els.fileInput.value = '';
    selectedFiles = [];
    renderFileList();
    els.progressBar.style.width = '0%';
    els.detailsForm.reset();
    els.identityForm.reset();
    updateNameChoice();
    showScreen('upload');
}

// ---------- HELPERS ----------
function createRandomTag() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    }
    if (globalThis.crypto?.getRandomValues) {
        const bytes = new Uint8Array(8);
        globalThis.crypto.getRandomValues(bytes);
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 12);
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`.slice(0, 12);
}

function safeName(name) {
    const clean=name.replace(/[\\/]/g, '_').replace(/[^\w.\- ()]/g, '_');
    const ext=clean.match(/\.[^.]{1,8}$/)?.[0] || '';
    return clean.length<=45 ? clean : clean.slice(0,45-ext.length)+ext;
}

function getAllowedContentType(file) {
    const reportedType = String(file.type || '').toLowerCase();
    if (ALLOWED_CONTENT_TYPES.has(reportedType)) {
        return reportedType;
    }

    // Some mobile browsers report HEIC/HEIF as an empty MIME type.
    const ext = file.name.split('.').pop()?.toLowerCase();
    const fallbackTypes = {
        avif: 'image/avif',
        bmp: 'image/bmp',
        tif: 'image/tiff',
        tiff: 'image/tiff',
        webm: 'video/webm',
        m4v: 'video/x-m4v',
        avi: 'video/x-msvideo',
        mpg: 'video/mpeg',
        mpeg: 'video/mpeg',
        '3gp': 'video/3gpp',
        '3g2': 'video/3gpp2',
        heic: 'image/heic',
        heif: 'image/heif',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        mov: 'video/quicktime',
        mp4: 'video/mp4',
        pdf: 'application/pdf',
    };
    return fallbackTypes[ext] || null;
}

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
