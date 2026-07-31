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
    buildManifestMap,
    firstDownloadToken,
    normalizeDriveBridgeResponse,
    validateSubmission,
};
