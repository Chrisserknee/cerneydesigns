const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function delivery(driveFiles = [], bucket = {}, fetchImpl = async()=>{throw Error("Unexpected request");}) {
    const context = vm.createContext({
        exports: {}, process, Buffer, URL, Date, AbortSignal, fetch:fetchImpl,
        require(name) {
            if (name === './tip-alerts') return {};
            if (name === 'google-auth-library') return { GoogleAuth: class { async getClient() { return { request: async () => ({ data: { files: driveFiles } }) }; } } };
            if (name === 'firebase-functions/v2/storage') return { onObjectFinalized: (_, handler) => handler };
            if (name === 'firebase-functions/v2/scheduler') return { onSchedule: (_, handler) => handler };
            if (name === 'firebase-functions/params') return { defineSecret: name => ({ value: () => name === 'DRIVE_BRIDGE_URL' ? 'https://script.google.com/macros/s/test/exec' : 'test' }) };
            if (name === 'firebase-functions') return { logger: { info() {}, warn() {}, error() {} } };
            if (name === 'firebase-admin/app') return { initializeApp() {} };
            if (name === 'firebase-admin/storage') return { getStorage: () => ({ bucket: () => bucket }) };
            return require(name);
        },
    });
    vm.runInContext(fs.readFileSync(__dirname + '/index.js', 'utf8') + '\nthis.fns = { verifyDriveContents, revokeDownloadTokens, buildFileLink, buildStoryDocument, mirrorSessionToDriveBridge };', context);
    return { ...context.fns, context };
}

test('Drive verification checks name, bytes, and checksum independently of bridge response', async () => {
    const source = { name: '01_video.mp4', sizeBytes: 100, md5Hash: Buffer.from('1234567890abcdef').toString('base64') };
    const file = { name: source.name, size: '100', md5Checksum: Buffer.from('1234567890abcdef').toString('hex') };
    await delivery([file]).verifyDriveContents('https://drive.google.com/drive/folders/test', [source]);
    for (const changed of [{ size: '99' }, { md5Checksum: 'wrong' }, { name: 'other.mp4' }]) {
        await assert.rejects(delivery([{ ...file, ...changed }]).verifyDriveContents('https://drive.google.com/drive/folders/test', [source]), /verification failed/);
    }
});

test('download token revocation explicitly deletes GCS metadata', async () => {
    let patch;
    await delivery().revokeDownloadTokens([{
        getMetadata: async () => [{ metadata: { anonymous: 'true', firebaseStorageDownloadTokens: 'private' } }],
        setMetadata: async update => { patch = update; },
    }]);
    assert.equal(patch.metadata.firebaseStorageDownloadTokens, null);
    assert.equal(patch.metadata.anonymous, 'true');
});

test('notification retry does not create another media download token', async () => {
    let writes = 0;
    await delivery().buildFileLink({ name: 'tips/test/photo.png', metadata: { size: '5' }, setMetadata() { writes++; } }, 'bucket', new Map(), false);
    assert.equal(writes, 0);
});

test('new Drive transfers never mint or forward public download tokens',async()=>{
 let writes=0;
 const link=await delivery().buildFileLink({name:'tips/test/photo.png',metadata:{size:'5',metadata:{firebaseStorageDownloadTokens:'old-token'}},setMetadata(){writes++;}},'bucket',new Map());
 assert.equal(writes,0);assert.doesNotMatch(link.url,/token|old-token/);
});

test('an unfinished media upload has its public token revoked without waiting for a manifest',async()=>{
 let patch;
 const file={getMetadata:async()=>[{metadata:{firebaseStorageDownloadTokens:'old-token'}}],setMetadata:async value=>{patch=value;}};
 const {context}=delivery([],{file:()=>file});
 await context.exports.notifyOnTip({data:{name:'tips/test/01_photo.png',bucket:'bucket'}});
 assert.equal(patch.metadata.firebaseStorageDownloadTokens,null);
});

test('a sent notification does not exclude media still waiting for Drive', async () => {
    const manifest = { name: 'tips/test/_submission.json', metadata: { name: 'tips/test/_submission.json', timeCreated: new Date(Date.now() - 7200000).toISOString(), generation: '1', metadata: { notificationStatus: 'sent' } } };
    const files = [manifest, { name: 'tips/test/01_video.mov' }];
    const { context } = delivery([], { name: 'bucket', getFiles: async () => [files] });
    let attempts = 0;
    context.processTip = async () => { attempts++; };
    await context.exports.retryTipDeliveries();
    assert.equal(attempts, 1);
    manifest.metadata.metadata.driveCopyStatus = 'complete';
    await context.exports.retryTipDeliveries();
    assert.equal(attempts, 1);
});


test('text-only stories have a verifiable Drive document without a public token', () => {
    const { createHash } = require('node:crypto');
    const doc = delivery().buildStoryDocument({type:'story_submission',fileCount:0,whatHappened:'A story'},'bucket','tips/session');
    assert.equal(doc.name,'01_STORY_DETAILS.json');
    assert.equal(doc.sizeBytes,doc.inlineBytes.length);
    assert.equal(doc.md5Hash,createHash('md5').update(doc.inlineBytes).digest('base64'));
    assert.equal(JSON.parse(doc.inlineBytes).whatHappened,'A story');
    assert.doesNotMatch(doc.url,/token=/);
});


test('verified media becomes accessible before a failed bridge finalization is retried', async () => {
    const source={name:'photo.jpg',sizeBytes:4,md5Hash:Buffer.from('1234567890abcdef').toString('base64')};
    const copied={name:source.name,sizeBytes:4,verified:true,id:'photo',md5Checksum:Buffer.from(source.md5Hash,'base64').toString('hex')};
    const events=[];let attempts=0;
    const {mirrorSessionToDriveBridge}=delivery([{...copied,size:'4'}],{},async(url,options)=>{
        assert.equal(url,'https://script.google.com/macros/s/test/exec');
        const action=JSON.parse(options.body).action;events.push(action);
        if(action==='prepare')return {ok:true,json:async()=>({ok:true,transferMode:'direct-v1',folderUrl:'https://drive.google.com/drive/folders/test',transfers:[copied]})};
        if(action==='finalize' && ++attempts===1)return {ok:false,json:async()=>{throw Error('Invalid JSON');}};
        return {ok:true,json:async()=>({ok:true,complete:true,folderUrl:'https://drive.google.com/drive/folders/test',copied:[copied]})};
    });
    await mirrorSessionToDriveBridge({deliveryId:'test',sessionLabel:'test',files:[source],onMediaReady:async()=>events.push('ready')});
    assert.deepEqual(events,['prepare','ready','finalize','finalize','release']);
});

test('a checksum mismatch never publishes a Drive link', async () => {
    let published=false;
    const {mirrorSessionToDriveBridge}=delivery([{name:'photo.jpg',size:'4',md5Checksum:'wrong'}],{},async(url,options)=>({ok:true,json:async()=>({ok:true,transferMode:'direct-v1',folderUrl:'https://drive.google.com/drive/folders/test',transfers:[{name:'photo.jpg',sizeBytes:4,verified:true}]})}));
    await assert.rejects(mirrorSessionToDriveBridge({files:[{name:'photo.jpg',sizeBytes:4,md5Hash:Buffer.from('1234567890abcdef').toString('base64')}],onMediaReady:async()=>{published=true;}}),/verification failed/);
    assert.equal(published,false);
});

test('Drive reconciliation retries a recent stuck upload and ignores old NTFY backlog',async()=>{
    const manifest={name:'tips/test/_submission.json',metadata:{name:'tips/test/_submission.json',timeCreated:new Date(Date.now()-360000).toISOString(),generation:'1',metadata:{notificationStatus:'pending'}}};
    const {context}=delivery([],{getFiles:async()=>[[manifest,{name:'tips/test/photo.jpg'}]]});
    let calls=0;context.processTip=async()=>calls++;
    await context.exports.retryTipDeliveries();assert.equal(calls,1);
    manifest.metadata.metadata.driveCopyStatus='complete';
    await context.exports.retryTipDeliveries();assert.equal(calls,1);
});
