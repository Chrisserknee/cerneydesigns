'use strict';

const APPLICATION_ID = /^sub_[A-Za-z0-9]{1,100}$/;
const MAX_RECORD_BYTES = 128 * 1024;

function createStore({ bucket, prefix = '_spotlight/v1/sandbox/applications/' }) {
    if (!bucket || typeof bucket.file !== 'function' || typeof bucket.getFiles !== 'function') throw new Error('Moderation storage is unavailable.');
    if (!/^_spotlight\/v1\/(sandbox|live)\/(applications|member-extras)\/$/.test(prefix)) throw new Error('Invalid moderation storage prefix.');

    function path(id) {
        if (!APPLICATION_ID.test(id || '')) throw new Error('Invalid application identifier.');
        return `${prefix}${id}.json`;
    }

    function validate(record, id) {
        if (!record || Array.isArray(record) || record.id !== id || !Number.isSafeInteger(record.revision) || record.revision < 0) throw new Error('Invalid moderation record.');
        const data = JSON.stringify(record);
        if (Buffer.byteLength(data) > MAX_RECORD_BYTES) throw new Error('Moderation record is too large.');
        return data;
    }

    async function version(id) {
        const name = path(id);
        for (let attempt = 0; attempt < 8; attempt += 1) {
            let metadata;
            try { [metadata] = await bucket.file(name).getMetadata(); }
            catch (error) { if (Number(error.code) === 404) return null; throw error; }
            if (Number(metadata.size) > MAX_RECORD_BYTES) throw new Error('Moderation record is too large.');
            try {
                // Pin the download to the same immutable generation observed above.
                const [bytes] = await bucket.file(name, { generation: metadata.generation }).download();
                if (bytes.length > MAX_RECORD_BYTES) throw new Error('Moderation record is too large.');
                const record = JSON.parse(bytes.toString('utf8'));
                validate(record, id);
                return { record, generation: metadata.generation };
            } catch (error) { if (Number(error.code) !== 404) throw error; }
        }
        throw new Error('Moderation storage changed repeatedly. Try again.');
    }

    async function save(id, record, generation) {
        const data = validate(record, id);
        try {
            await bucket.file(path(id)).save(data, {
                resumable: false,
                contentType: 'application/json',
                metadata: { cacheControl: 'private, no-store', metadata: {
                    spotlightWorkState: String(record.work?.state || 'idle'),
                    spotlightNextAttemptAt: String(record.work?.nextAttemptAt || 0),
                    spotlightLeaseUntil: String(record.work?.leaseUntil || 0),
                } },
                preconditionOpts: { ifGenerationMatch: generation },
            });
            return true;
        } catch (error) { if (Number(error.code) === 412) return false; throw error; }
    }

    return {
        async read(id) { return (await version(id))?.record || null; },
        async create(id, record) { return save(id, record, 0); },
        async compareAndSwap(id, expectedRevision, nextRecord) {
            if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || nextRecord?.revision !== expectedRevision + 1) throw new Error('Invalid moderation revision.');
            const current = await version(id);
            if (!current || current.record.revision !== expectedRevision) return false;
            return save(id, nextRecord, current.generation);
        },
        async listDue({ now = Date.now(), limit = 20 } = {}) {
            const boundedLimit = Math.min(100, Math.max(1, Number.isSafeInteger(limit) ? limit : 20));
            const due = [];
            let pageToken;
            do {
                const [files, nextQuery] = await bucket.getFiles({ prefix, autoPaginate: false, maxResults: 100, ...(pageToken ? { pageToken } : {}) });
                for (const file of files) {
                    const suffix = file.name.slice(prefix.length);
                    const id = suffix.endsWith('.json') ? suffix.slice(0, -5) : '';
                    if (!APPLICATION_ID.test(id) || file.name !== path(id)) continue;
                    const metadata = file.metadata?.metadata;
                    if (metadata && !hasDueWork({ work: { state: metadata.spotlightWorkState, nextAttemptAt: metadata.spotlightNextAttemptAt, leaseUntil: metadata.spotlightLeaseUntil } }, now)) continue;
                    const record = await this.read(id);
                    if (record && hasDueWork(record, now)) due.push(record);
                }
                pageToken = nextQuery?.pageToken;
            } while (pageToken);
            return due.sort((a, b) => a.work.nextAttemptAt - b.work.nextAttemptAt || a.id.localeCompare(b.id)).slice(0, boundedLimit);
        },
    };
}

// Kept separate from provider calls so scans never mutate billing or send mail.
function hasDueWork(record, now) {
    const work = record.work;
    return Boolean(work && ['queued', 'leased'].includes(work.state)
        && Number(work.nextAttemptAt) <= now && Number(work.leaseUntil || 0) <= now);
}

module.exports = { createStore, hasDueWork, APPLICATION_ID, MAX_RECORD_BYTES };
