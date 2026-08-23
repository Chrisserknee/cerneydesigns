const MAX_FILE_BYTES = 500 * 1024 * 1024;
const MAX_TOTAL_BYTES = 750 * 1024 * 1024;
const MAX_FILES = 10;
const ALLOWED_CONTENT_TYPES = new Set([
    'application/pdf',
    'image/avif',
    'image/bmp',
    'image/gif',
    'image/heic',
    'image/heif',
    'image/jpeg',
    'image/png',
    'image/tiff',
    'image/webp',
    'video/3gpp',
    'video/3gpp2',
    'video/mp4',
    'video/mpeg',
    'video/quicktime',
    'video/webm',
    'video/x-m4v',
    'video/x-msvideo',
]);

function buildManifestMap(submission) {
    const result = new Map();
    if (!Array.isArray(submission.files)) return result;
    for (const file of submission.files) {
        if (!file || typeof file !== 'object') continue;
        const storedName = String(file.storedName || file.name || '').split('/').pop();
        if (storedName) result.set(storedName, file);
    }
    return result;
}

function sanitizeSubmission(submission) {
    const source = submission && typeof submission === 'object' ? submission : {};
    const anonymous = source.anonymous === true;
    const clean = {
        ...source,
        anonymous,
        senderName: anonymous ? '' : cleanText(source.senderName, 200),
        senderContact: anonymous ? '' : cleanText(source.senderContact, 300),
        userAgent: anonymous ? '' : cleanText(source.userAgent, 500),
        description: cleanText(source.description, 6000),
        whatHappened: cleanText(source.whatHappened, 2000),
        location: cleanText(source.location, 300),
        timing: cleanText(source.timing, 300),
        extraContext: cleanText(source.extraContext, 1500),
    };
    return clean;
}

function validateSubmissionForProcessing(submission, files) {
    const errors = [];
    const isStorySubmission = submission?.type === 'story_submission';
    const actualFiles = Array.isArray(files) ? files : [];
    const actualBytes = actualFiles.reduce((sum, file) => sum + Number(file.sizeBytes || 0), 0);
    const expectedCount = Number(submission?.fileCount);
    const expectedBytes = Number(submission?.totalBytes);

    if (!submission || typeof submission !== 'object' || Array.isArray(submission)) {
        errors.push('Submission manifest must be an object.');
        return errors;
    }
    if (!isStorySubmission && actualFiles.length === 0) {
        errors.push('Tip submission contains no files.');
    }
    if (actualFiles.length > MAX_FILES) {
        errors.push(`Submission exceeds the ${MAX_FILES}-file limit.`);
    }
    if (actualBytes > MAX_TOTAL_BYTES) {
        errors.push('Submission exceeds the total upload-size limit.');
    }
    if (!Number.isInteger(expectedCount) || expectedCount !== actualFiles.length) {
        errors.push('Manifest file count does not match Storage.');
    }
    if (!Number.isFinite(expectedBytes) || expectedBytes !== actualBytes) {
        errors.push('Manifest byte count does not match Storage.');
    }

    for (const file of actualFiles) {
        const size = Number(file.sizeBytes || 0);
        if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES) {
            errors.push(`Invalid file size for "${file.name || 'upload'}".`);
        }
        if (!ALLOWED_CONTENT_TYPES.has(String(file.mimeType || '').toLowerCase())) {
            errors.push(`Unsupported file type for "${file.name || 'upload'}".`);
        }
    }
    return errors;
}

function buildPrivacySafeNotification(submission, files, integrityWarnings, consoleUrl) {
    const isStorySubmission = submission?.type === 'story_submission';
    const fileCount = Array.isArray(files) ? files.length : 0;
    const lines = [
        isStorySubmission
            ? 'A new story submission was received.'
            : 'A new tipline upload was received.',
        fileCount
            ? `${fileCount} file${fileCount === 1 ? '' : 's'} attached.`
            : 'No files attached.',
    ];
    if (integrityWarnings?.length) {
        lines.push('The upload integrity check needs attention.');
    }
    lines.push('Open the secure destination to review it.');

    return {
        title: isStorySubmission ? 'New Story Submission' : 'New Tipline Upload',
        message: lines.join('\n'),
        consoleUrl,
    };
}

function cleanText(value, maxLength) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function firstDownloadToken(tokens) {
    return tokens
        ? String(tokens).split(',').map((token) => token.trim()).find(Boolean) || null
        : null;
}

function validateSubmission(submission, files) {
    const warnings = [];
    const expectedCount = Number(submission.fileCount);
    const actualBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
    const expectedBytes = Number(submission.totalBytes);

    if (Number.isFinite(expectedCount) && expectedCount !== files.length) {
        warnings.push(`Manifest lists ${expectedCount} files; Storage contains ${files.length}.`);
    }
    if (Number.isFinite(expectedBytes) && expectedBytes !== actualBytes) {
        warnings.push(`Manifest lists ${expectedBytes} bytes; Storage contains ${actualBytes}.`);
    }

    const manifestFiles = Array.isArray(submission.files) ? submission.files : [];
    const actualNames = new Set(files.map((file) => file.name));
    for (const manifestFile of manifestFiles) {
        const storedName = String(manifestFile?.storedName || manifestFile?.name || '').split('/').pop();
        if (storedName && !actualNames.has(storedName)) {
            warnings.push(`Storage is missing manifest file "${storedName}".`);
        }
    }
    return warnings;
}

function normalizeDriveBridgeResponse(payload, files) {
    const copiedCount = Array.isArray(payload?.copied)
        ? payload.copied.length
        : Number.isInteger(payload?.copied)
            ? payload.copied
            : null;
    const isVerifiedResponse = payload?.complete === true;
    const isLegacySuccess = payload?.complete == null && payload?.ok === true;

    if ((!isVerifiedResponse && !isLegacySuccess) || !payload?.folderUrl || copiedCount == null) {
        throw new Error('Drive bridge did not confirm a complete copy.');
    }
    if (copiedCount !== files.length) {
        throw new Error(`Drive bridge copied ${copiedCount} of ${files.length} files.`);
    }

    const copied = Array.isArray(payload.copied)
        ? payload.copied
        : files.map((file) => ({ name: file.name, legacyResponse: true }));

    return {
        ...payload,
        complete: true,
        copied,
    };
}

module.exports = {
    ALLOWED_CONTENT_TYPES,
    buildManifestMap,
    buildPrivacySafeNotification,
    firstDownloadToken,
    normalizeDriveBridgeResponse,
    sanitizeSubmission,
    validateSubmission,
    validateSubmissionForProcessing,
};
