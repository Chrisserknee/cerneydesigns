import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
    getStorage,
    ref,
    uploadBytes,
    uploadBytesResumable,
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

const MAX_FILE_BYTES = 500 * 1024 * 1024;
const MAX_TOTAL_BYTES = 750 * 1024 * 1024;
const MAX_FILES_PER_SUBMISSION = 10;
const CONCURRENCY = 2;

const els = {
    form: document.getElementById('storyIdeaForm'),
    steps: [...document.querySelectorAll('.wizard-step')],
    stepLabel: document.getElementById('stepLabel'),
    progressBar: document.getElementById('progressBar'),
    prevBtn: document.getElementById('prevBtn'),
    nextBtn: document.getElementById('nextBtn'),
    submitBtn: document.getElementById('submitBtn'),
    formError: document.getElementById('formError'),
    reviewCard: document.getElementById('reviewCard'),
    contactFields: document.getElementById('contactFields'),
    successScreen: document.getElementById('successScreen'),
    sendAnother: document.getElementById('sendAnother'),
    whatHappened: document.getElementById('whatHappened'),
    storyLocation: document.getElementById('storyLocation'),
    storyTiming: document.getElementById('storyTiming'),
    senderName: document.getElementById('senderName'),
    senderContact: document.getElementById('senderContact'),
    extraContext: document.getElementById('extraContext'),
    mediaUploadPanel: document.getElementById('mediaUploadPanel'),
    fileDropzone: document.getElementById('fileDropzone'),
    fileInput: document.getElementById('fileInput'),
    fileList: document.getElementById('fileList'),
};

const reviewStepIndex = els.steps.length - 1;
let currentStep = 0;
let isSubmitting = false;
let selectedFiles = [];

els.prevBtn.addEventListener('click', () => {
    if (currentStep > 0) {
        showStep(currentStep - 1);
    }
});

els.nextBtn.addEventListener('click', () => {
    if (!validateStep(currentStep)) return;
    if (currentStep === reviewStepIndex - 1) {
        renderReview();
    }
    showStep(currentStep + 1);
});

els.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (isSubmitting || !validateStep(currentStep)) return;
    await submitStoryIdea();
});

els.form.addEventListener('change', (event) => {
    if (event.target.name === 'hasMedia') {
        updateMediaUploadPanel();
    }

    if (event.target.name === 'canContact') {
        const canContact = getRadioValue('canContact') === 'Yes';
        els.contactFields.hidden = !canContact;
        if (!canContact) {
            els.senderName.value = '';
            els.senderContact.value = '';
        }
    }
    clearError();
});

els.form.addEventListener('input', clearError);

els.fileInput.addEventListener('change', (event) => {
    addFiles(Array.from(event.target.files || []));
    setTimeout(() => { els.fileInput.value = ''; }, 0);
});

['dragenter', 'dragover'].forEach((eventName) => {
    els.fileDropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        els.fileDropzone.classList.add('drag-over');
    });
});

['dragleave', 'drop'].forEach((eventName) => {
    els.fileDropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        els.fileDropzone.classList.remove('drag-over');
    });
});

els.fileDropzone.addEventListener('drop', (event) => {
    if (event.dataTransfer?.files?.length) {
        addFiles(Array.from(event.dataTransfer.files));
    }
});

els.fileList.addEventListener('click', (event) => {
    const removeBtn = event.target.closest('.file-item-remove');
    if (!removeBtn) return;
    selectedFiles.splice(Number(removeBtn.dataset.idx), 1);
    renderFileList();
});

els.sendAnother.addEventListener('click', () => {
    els.form.reset();
    selectedFiles = [];
    renderFileList();
    els.mediaUploadPanel.hidden = true;
    els.contactFields.hidden = true;
    els.successScreen.hidden = true;
    document.querySelector('.wizard-shell').hidden = false;
    showStep(0);
});

showStep(0);

function updateMediaUploadPanel() {
    const hasMedia = getRadioValue('hasMedia');
    const shouldShow = hasMedia && !hasMedia.startsWith('No,');
    els.mediaUploadPanel.hidden = !shouldShow;
    if (!shouldShow) {
        selectedFiles = [];
        renderFileList();
    }
}

function addFiles(files) {
    const rejected = [];
    for (const file of files) {
        if (file.size > MAX_FILE_BYTES) {
            rejected.push(`${file.name} (too large)`);
            continue;
        }
        if (!getAllowedContentType(file)) {
            rejected.push(`${file.name} (unsupported file type)`);
            continue;
        }
        if (selectedFiles.length >= MAX_FILES_PER_SUBMISSION) {
            rejected.push(`${file.name} (too many files)`);
            continue;
        }
        const nextTotal = selectedFiles.reduce((sum, f) => sum + f.size, 0) + file.size;
        if (nextTotal > MAX_TOTAL_BYTES) {
            rejected.push(`${file.name} (submission total too large)`);
            continue;
        }
        if (!selectedFiles.some(f => f.name === file.name && f.size === file.size)) {
            selectedFiles.push(file);
        }
    }

    renderFileList();
    if (rejected.length) {
        showError(
            `Some files were not added: ${rejected.join(', ')}. ` +
            `Limits: ${MAX_FILES_PER_SUBMISSION} files, ${formatBytes(MAX_FILE_BYTES)} each, ${formatBytes(MAX_TOTAL_BYTES)} total.`
        );
    }
}

function renderFileList() {
    els.fileList.innerHTML = '';
    selectedFiles.forEach((file, idx) => {
        const item = document.createElement('li');
        item.className = 'file-item';

        const name = document.createElement('span');
        name.className = 'file-item-name';
        name.textContent = file.name.length > 56 ? `${file.name.slice(0, 53)}...` : file.name;
        name.title = file.name;

        const size = document.createElement('span');
        size.className = 'file-item-size';
        size.textContent = formatBytes(file.size);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'file-item-remove';
        remove.dataset.idx = String(idx);
        remove.setAttribute('aria-label', `Remove ${file.name}`);
        remove.textContent = 'x';

        item.append(name, size, remove);
        els.fileList.appendChild(item);
    });
}

function showStep(index) {
    currentStep = Math.max(0, Math.min(index, reviewStepIndex));
    els.steps.forEach((step, idx) => {
        step.classList.toggle('active', idx === currentStep);
    });

    const isReview = currentStep === reviewStepIndex;
    els.prevBtn.hidden = currentStep === 0;
    els.nextBtn.hidden = isReview;
    els.submitBtn.hidden = !isReview;
    els.stepLabel.textContent = isReview ? 'Review' : `Step ${currentStep + 1} of ${reviewStepIndex}`;
    els.progressBar.style.width = `${Math.round(((currentStep + 1) / els.steps.length) * 100)}%`;
    clearError();
}

function validateStep(index) {
    clearError();
    const step = els.steps[index];
    const requiredFields = [...step.querySelectorAll('[required]')];

    for (const field of requiredFields) {
        if (field.type === 'radio') {
            const checked = step.querySelector(`input[name="${field.name}"]:checked`);
            if (!checked) {
                showError('Choose an option before continuing.');
                return false;
            }
            continue;
        }

        if (!field.value.trim()) {
            field.focus();
            showError('Fill this out before continuing.');
            return false;
        }
    }

    if (index === 4 && getRadioValue('canContact') === 'Yes' && !els.senderContact.value.trim()) {
        els.senderContact.focus();
        showError('Add a phone, email, or Instagram so Chris can follow up.');
        return false;
    }

    return true;
}

function collectData() {
    const canContact = getRadioValue('canContact') === 'Yes';
    const anonymous = getRadioValue('anonymous') === 'Yes';
    return {
        type: 'story_submission',
        title: 'Story Submission / Potential Investigation',
        whatHappened: els.whatHappened.value.trim(),
        location: els.storyLocation.value.trim(),
        timing: els.storyTiming.value.trim(),
        hasMedia: getRadioValue('hasMedia'),
        fileCount: selectedFiles.length,
        totalBytes: selectedFiles.reduce((sum, file) => sum + file.size, 0),
        files: selectedFiles.map(file => ({
            name: file.name,
            size: file.size,
            type: getAllowedContentType(file) || file.type || '',
        })),
        canContact: canContact ? 'Yes' : 'No',
        senderName: canContact && !anonymous ? els.senderName.value.trim() : '',
        senderContact: canContact ? els.senderContact.value.trim() : '',
        anonymous,
        extraContext: els.extraContext.value.trim(),
        submittedAt: new Date().toISOString(),
        userAgent: anonymous ? '' : navigator.userAgent,
    };
}

function renderReview() {
    const data = collectData();
    const items = [
        ['What happened?', data.whatHappened],
        ['Where?', data.location],
        ['When?', data.timing],
        ['Photos / video / documents?', data.hasMedia],
        ['Attached files', data.files.length ? data.files.map(file => `${file.name} (${formatBytes(file.size)})`).join('\n') : 'None attached'],
        ['Can Chris contact you?', data.canContact],
        ['Contact', data.senderContact || 'Not provided'],
        ['Anonymous?', data.anonymous ? 'Yes' : 'No'],
        ['Extra context', data.extraContext || 'Not provided'],
    ];

    els.reviewCard.innerHTML = '';
    for (const [label, value] of items) {
        const item = document.createElement('div');
        item.className = 'review-item';

        const labelEl = document.createElement('span');
        labelEl.className = 'review-label';
        labelEl.textContent = label;

        const valueEl = document.createElement('span');
        valueEl.className = 'review-value';
        valueEl.textContent = value;

        item.append(labelEl, valueEl);
        els.reviewCard.appendChild(item);
    }
}

async function submitStoryIdea() {
    isSubmitting = true;
    els.submitBtn.disabled = true;
    els.submitBtn.textContent = selectedFiles.length ? 'Uploading Files...' : 'Sending...';

    const data = collectData();

    try {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const ts = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}_${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}`;
        const rand = Math.random().toString(36).slice(2, 8);
        const sessionFolder = `tips/submit-story_${ts}_${rand}`;
        const uploadedFiles = await uploadSelectedFiles(sessionFolder, data);
        const uploadedBytes = uploadedFiles.reduce((sum, file) => sum + file.size, 0);
        const description = [
            'STORY SUBMISSION / POTENTIAL INVESTIGATION',
            '',
            `What happened: ${data.whatHappened}`,
            `Where: ${data.location}`,
            `When: ${data.timing}`,
            `Photos/video/documents: ${data.hasMedia}`,
            uploadedFiles.length ? `Attached files: ${uploadedFiles.map(file => file.name).join(', ')}` : 'Attached files: none',
            `Can contact: ${data.canContact}`,
            `Anonymous: ${data.anonymous ? 'Yes' : 'No'}`,
            data.extraContext ? `Extra context: ${data.extraContext}` : '',
        ].filter(Boolean).join('\n');
        const submission = {
            ...data,
            fileCount: uploadedFiles.length,
            totalBytes: uploadedBytes,
            files: uploadedFiles,
            description,
        };
        const body = JSON.stringify(submission, null, 2);
        const fileRef = ref(storage, `${sessionFolder}/_submission.json`);

        els.submitBtn.textContent = 'Finishing...';
        await uploadBytes(fileRef, new Blob([body], { type: 'application/json' }), {
            contentType: 'application/json',
            customMetadata: {
                submissionType: 'story_submission',
                anonymous: String(data.anonymous),
            },
        });

        document.querySelector('.wizard-shell').hidden = true;
        els.successScreen.hidden = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
        console.error(err);
        showError('Could not send this story submission. Try again, or use the tipline upload page.');
    } finally {
        isSubmitting = false;
        els.submitBtn.disabled = false;
        els.submitBtn.textContent = 'Submit a Story';
    }
}

async function uploadSelectedFiles(sessionFolder, data) {
    if (!selectedFiles.length) return [];

    const uploaded = [];
    let nextIdx = 0;
    let completed = 0;
    const customMetadata = { anonymous: String(data.anonymous), submissionType: 'story_submission' };
    if (!data.anonymous) {
        if (data.senderName) customMetadata.senderName = data.senderName.slice(0, 200);
        if (data.senderContact) customMetadata.senderContact = data.senderContact.slice(0, 200);
        if (data.userAgent) customMetadata.userAgent = data.userAgent.slice(0, 500);
    }
    if (data.whatHappened) customMetadata.description = data.whatHappened.slice(0, 1000);

    const uploadOne = (file, idx) => new Promise((resolve, reject) => {
        const contentType = getAllowedContentType(file);
        const safeFileName = `${String(idx + 1).padStart(2, '0')}_${safeName(file.name)}`;
        const storageRef = ref(storage, `${sessionFolder}/${safeFileName}`);
        const task = uploadBytesResumable(storageRef, file, {
            contentType,
            customMetadata,
        });

        task.on(
            'state_changed',
            () => {
                els.submitBtn.textContent = `Uploading ${completed + 1}/${selectedFiles.length}`;
            },
            (error) => {
                console.error(`Upload failed for ${file.name}:`, error);
                reject(new Error(`Upload failed on "${file.name}". Please try again.`));
            },
            () => {
                completed++;
                uploaded[idx] = {
                    name: file.name,
                    storedName: safeFileName,
                    size: file.size,
                    type: contentType,
                };
                resolve();
            }
        );
    });

    const worker = async () => {
        while (true) {
            const idx = nextIdx++;
            if (idx >= selectedFiles.length) break;
            await uploadOne(selectedFiles[idx], idx);
        }
    };

    const workers = [];
    const concurrency = Math.min(CONCURRENCY, selectedFiles.length);
    for (let i = 0; i < concurrency; i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    return uploaded.filter(Boolean);
}

function getRadioValue(name) {
    return els.form.querySelector(`input[name="${name}"]:checked`)?.value || '';
}

function getAllowedContentType(file) {
    if (file.type?.startsWith('image/') || file.type?.startsWith('video/') || file.type === 'application/pdf') {
        return file.type;
    }

    const ext = file.name.split('.').pop()?.toLowerCase();
    const fallbackTypes = {
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

function safeName(name) {
    return name.replace(/[\\/]/g, '_').replace(/[^\w.\- ()]/g, '_').slice(0, 160) || 'upload';
}

function formatBytes(bytes) {
    if (bytes < 1024) return Math.round(bytes) + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function showError(message) {
    els.formError.textContent = message;
    els.formError.hidden = false;
}

function clearError() {
    els.formError.textContent = '';
    els.formError.hidden = true;
}
