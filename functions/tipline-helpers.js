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

module.exports = {
    buildManifestMap,
    firstDownloadToken,
    validateSubmission,
};
