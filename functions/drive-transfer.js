const CHUNK_BYTES = 8 * 1024 * 1024;

function driveTransferManifest(files) {
    // Match Apps Script safeName_ and retain the exact original Storage key.
    const seen = new Set();
    return files.map(file => {
        const name = String(file.name).replace(/[\\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180) || 'upload';
        if (seen.has(name)) throw new Error('Drive filenames normalize to the same name.');
        seen.add(name);
        return { ...file, name, storageName: file.name };
    });
}

async function transferToDrive(transfer, readChunk, { fetchImpl = fetch, deadline = Date.now() + 420000 } = {}) {
    if (transfer.verified) return;
    const url = new URL(transfer.uploadUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'www.googleapis.com' || url.pathname !== '/upload/drive/v3/files') {
        throw new Error('Invalid Drive upload destination.');
    }
    const size = Number(transfer.sizeBytes);
    let offset = Number(transfer.nextOffset);
    if (!Number.isSafeInteger(size) || size <= 0 || !Number.isSafeInteger(offset) || offset < 0 || offset >= size) {
        throw new Error('Invalid Drive transfer size or offset.');
    }
    while (offset < size) {
        if (Date.now() >= deadline) throw new Error('Drive delivery paused and will resume on retry.');
        const end = Math.min(offset + CHUNK_BYTES, size) - 1;
        const bytes = await readChunk(offset, end);
        if (bytes.length !== end - offset + 1) throw new Error('Source download returned an incomplete chunk.');
        const response = await fetchImpl(url, {
            method: 'PUT', redirect: 'manual', signal: AbortSignal.timeout(60000),
            headers: { 'Content-Type': transfer.mimeType || 'application/octet-stream', 'Content-Range': `bytes ${offset}-${end}/${size}` },
            body: bytes,
        });
        if (response.status === 200 || response.status === 201) {
            const file = await response.json();
            const checksum = Buffer.from(transfer.md5Hash, 'base64').toString('hex');
            if (!file.id || Number(file.size) !== size || file.md5Checksum !== checksum) throw new Error('Drive completion failed size or checksum verification.');
            return file;
        }
        if (response.status !== 308) throw new Error(`Drive chunk transfer HTTP ${response.status}.`);
        const match = /^bytes=0-(\d+)$/i.exec(response.headers.get('range') || '');
        const next = match ? Number(match[1]) + 1 : 0;
        if (next <= offset || next > end + 1) throw new Error('Drive did not acknowledge the uploaded chunk.');
        offset = next;
    }
    throw new Error('Drive has not confirmed file completion.');
}

module.exports = { transferToDrive, driveTransferManifest };
