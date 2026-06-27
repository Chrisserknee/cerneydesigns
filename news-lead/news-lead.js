import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
    getStorage,
    ref,
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
};

const reviewStepIndex = els.steps.length - 1;
let currentStep = 0;
let isSubmitting = false;

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

els.sendAnother.addEventListener('click', () => {
    els.form.reset();
    els.contactFields.hidden = true;
    els.successScreen.hidden = true;
    document.querySelector('.wizard-shell').hidden = false;
    showStep(0);
});

showStep(0);

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
        type: 'news_lead',
        title: 'News Lead / Potential Investigation',
        whatHappened: els.whatHappened.value.trim(),
        location: els.storyLocation.value.trim(),
        timing: els.storyTiming.value.trim(),
        hasMedia: getRadioValue('hasMedia'),
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
        ['Photos / video?', data.hasMedia],
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
    els.submitBtn.textContent = 'Sending...';

    const data = collectData();
    const description = [
        'NEWS LEAD / POTENTIAL INVESTIGATION',
        '',
        `What happened: ${data.whatHappened}`,
        `Where: ${data.location}`,
        `When: ${data.timing}`,
        `Photos/video: ${data.hasMedia}`,
        `Can contact: ${data.canContact}`,
        `Anonymous: ${data.anonymous ? 'Yes' : 'No'}`,
        data.extraContext ? `Extra context: ${data.extraContext}` : '',
    ].filter(Boolean).join('\n');

    const submission = {
        ...data,
        description,
    };

    try {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const ts = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}_${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}`;
        const rand = Math.random().toString(36).slice(2, 8);
        const sessionFolder = `tips/news-lead_${ts}_${rand}`;
        const body = JSON.stringify(submission, null, 2);
        const fileRef = ref(storage, `${sessionFolder}/_submission.json`);

        await uploadBytes(fileRef, new Blob([body], { type: 'application/json' }), {
            contentType: 'application/json',
            customMetadata: {
                submissionType: 'news_lead',
                anonymous: String(data.anonymous),
            },
        });

        document.querySelector('.wizard-shell').hidden = true;
        els.successScreen.hidden = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
        console.error(err);
        showError('Could not send this news lead. Try again, or use the tipline upload page.');
    } finally {
        isSubmitting = false;
        els.submitBtn.disabled = false;
        els.submitBtn.textContent = 'Submit a News Lead';
    }
}

function getRadioValue(name) {
    return els.form.querySelector(`input[name="${name}"]:checked`)?.value || '';
}

function showError(message) {
    els.formError.textContent = message;
    els.formError.hidden = false;
}

function clearError() {
    els.formError.textContent = '';
    els.formError.hidden = true;
}
