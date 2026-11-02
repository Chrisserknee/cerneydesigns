'use strict';
const {createHash}=require('node:crypto');

// Revision covers all card content (including removals, expiry and media
// descriptors). Health timestamps travel separately so heartbeats stay small.
function inboxResponse(content, health, knownRevision){
    const contentRevision=createHash('sha256').update(JSON.stringify(content)).digest('hex');
    return knownRevision===contentRevision
        ? {...health,contentRevision,unchanged:true}
        : {...health,contentRevision,...content};
}
module.exports={inboxResponse};
