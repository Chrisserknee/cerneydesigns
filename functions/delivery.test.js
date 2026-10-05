const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function delivery(driveFiles = [], bucket = {}, fetchImpl = async()=>{throw Error("Unexpected request");}) {
    const context = vm.createContext({
        exports: {}, process, Buffer, URL, Date, AbortSignal, fetch:fetchImpl,
        require(name) {
            if (name === './tip-alerts') return {};
            if (name === './upload-admission') return {permittedObject:async()=>true};
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

test('a checksum mismatch never marks media ready', async () => {
    let published=false;
    const {mirrorSessionToDriveBridge}=delivery([{name:'photo.jpg',size:'4',md5Checksum:'wrong'}],{},async(url,options)=>({ok:true,json:async()=>({ok:true,transferMode:'direct-v1',folderUrl:'https://drive.google.com/drive/folders/test',transfers:[{name:'photo.jpg',sizeBytes:4,verified:true}]})}));
    await assert.rejects(mirrorSessionToDriveBridge({files:[{name:'photo.jpg',sizeBytes:4,md5Hash:Buffer.from('1234567890abcdef').toString('base64')}],onMediaReady:async()=>{published=true;}}),/verification failed/);
    assert.equal(published,false);
});

test('double-space filenames complete Drive delivery under the bridge-normalized name',async()=>{
 const source={name:'01_video  clip.MP4',originalName:'original  clip.MP4',sizeBytes:4,md5Hash:Buffer.from('1234567890abcdef').toString('base64')};
 const copied={name:'01_video clip.MP4',sizeBytes:4,verified:true,id:'video',md5Checksum:Buffer.from(source.md5Hash,'base64').toString('hex')};
 const events=[];
 const {mirrorSessionToDriveBridge}=delivery([{...copied,size:'4'}],{},async(url,options)=>{
   const body=JSON.parse(options.body);events.push(body.action);
   assert.equal(body.files[0].name,copied.name);assert.equal(body.files[0].originalName,source.originalName);
   assert.equal(body.files[0].storageName,undefined);
   return {ok:true,json:async()=>({ok:true,complete:true,transferMode:'direct-v1',transfers:[copied],folderUrl:'https://drive.google.com/drive/folders/test',copied:[copied]})};
 });
 await mirrorSessionToDriveBridge({deliveryId:'test',sessionLabel:'test',files:[source],onMediaReady:async()=>events.push('ready')});
 assert.deepEqual(events,['prepare','ready','finalize','release']);assert.equal(source.name,'01_video  clip.MP4');
});

test('Drive reconciliation retries a recent stuck upload and ignores old NTFY backlog',async()=>{
    const manifest={name:'tips/test/_submission.json',metadata:{name:'tips/test/_submission.json',timeCreated:new Date(Date.now()-360000).toISOString(),generation:'1',metadata:{notificationStatus:'pending'}}};
    const {context}=delivery([],{getFiles:async()=>[[manifest,{name:'tips/test/photo.jpg'}]]});
    let calls=0;context.processTip=async()=>calls++;
    await context.exports.retryTipDeliveries();assert.equal(calls,1);
    manifest.metadata.metadata.driveCopyStatus='complete';
    await context.exports.retryTipDeliveries();assert.equal(calls,1);
});

function contextBucket({ready=false,wrongToken=false}={}) {
 const {createHash}=require('node:crypto'), token='a'.repeat(64), records=new Map(), events=[];
 const folder='tips/test';
 const put=(name,data,generation,metadata={})=>records.set(name,{name,generation,size:String(Buffer.byteLength(JSON.stringify(data))),timeCreated:'2026-10-04T00:00:00Z',metadata,bytes:Buffer.from(JSON.stringify(data))});
 put(folder+'/_submission.json',{contextKeyHash:createHash('sha256').update(token).digest('hex')},'11',ready?{driveCopyStatus:'complete',driveFolderUrl:'https://drive.google.com/drive/folders/original'}:{});
 put(folder+'/_context.json',{contextToken:wrongToken?'b'.repeat(64):token,anonymous:true,nameUsageConsent:'anonymous',detailsStatus:'provided',whatHappened:'Test follow-up',location:'Salinas'},'12');
 const bucket={name:'bucket',file(name){return {name,async getMetadata(){if(!records.has(name))throw Object.assign(Error('missing'),{code:404});return [records.get(name)];},async download(){return [records.get(name).bytes];},async save(data,options){assert.equal(options.preconditionOpts.ifGenerationMatch,0);if(records.has(name))throw Object.assign(Error('exists'),{code:412});put(name,JSON.parse(data),'13');events.push('verified-event');},async setMetadata(update){Object.assign(records.get(name).metadata,update.metadata);return [records.get(name)];}};}};
 return {bucket,records,events,event:{data:{name:folder+'/_context.json',bucket:'bucket',generation:'12'}}};
}
test('context publishes one verified editing event before Drive is ready, then appends to ORIGINAL folder',async()=>{
 const c=contextBucket(),d=delivery([],c.bucket);let uploads=0;
 d.context.mirrorSessionToDriveBridge=async args=>{uploads++;assert.equal(args.appendOnly,true);assert.equal(args.expectedFolderUrl,'https://drive.google.com/drive/folders/original');assert.equal(args.sessionLabel,'test');assert.equal(args.files.length,2);assert.doesNotMatch(JSON.stringify(args.submission),/contextToken/);return {folderUrl:args.expectedFolderUrl};};
 await assert.rejects(d.context.exports.notifyOnTip(c.event),/still pending/);
 assert.deepEqual(c.events,['verified-event']);assert.equal(uploads,0);
 Object.assign(c.records.get('tips/test/_submission.json').metadata,{driveCopyStatus:'complete',driveFolderUrl:'https://drive.google.com/drive/folders/original'});
 await d.context.exports.notifyOnTip(c.event);await d.context.exports.notifyOnTip(c.event);
 assert.deepEqual(c.events,['verified-event']);assert.equal(uploads,1);assert.equal(c.records.get('tips/test/_context.json').metadata.contextDriveStatus,'complete');
 const canonical=JSON.parse(c.records.get('tips/test/_context_ready.json').bytes);assert.equal(canonical.submissionGeneration,'11');assert.equal(canonical.submissionName,'tips/test/_submission.json');assert.doesNotMatch(JSON.stringify(canonical),/contextToken/);
});
test('invalid follow-up capability cannot create a trusted event or write Drive',async()=>{
 const c=contextBucket({ready:true,wrongToken:true}),d=delivery([],c.bucket);
 await d.context.exports.notifyOnTip(c.event);assert.deepEqual(c.events,[]);assert.equal(c.records.get('tips/test/_context.json').metadata.processingStatus,'rejected');
});
test('append-only Drive copy validates same folder and never rewrites original completion marker',async()=>{
 const source={name:'_additional_tip_context.json',sizeBytes:4,md5Hash:Buffer.from('1234567890abcdef').toString('base64')};
 const copied={name:source.name,sizeBytes:4,verified:true,id:'context',md5Checksum:Buffer.from(source.md5Hash,'base64').toString('hex')};const actions=[];
 const d=delivery([{...copied,size:'4'}],{},async(url,options)=>{const action=JSON.parse(options.body).action;actions.push(action);return {ok:true,json:async()=>({ok:true,transferMode:'direct-v1',folderUrl:'https://drive.google.com/drive/folders/original',transfers:[copied]})};});
 await d.mirrorSessionToDriveBridge({deliveryId:'context',sessionLabel:'test',files:[source],appendOnly:true,expectedFolderUrl:'https://drive.google.com/drive/folders/original'});
 assert.deepEqual(actions,['prepare','release']);
 await assert.rejects(d.mirrorSessionToDriveBridge({deliveryId:'context',sessionLabel:'test',files:[source],appendOnly:true,expectedFolderUrl:'https://drive.google.com/drive/folders/WRONG'}),/destination/);
 assert.deepEqual(actions,['prepare','release','prepare','release']);
});

test('folder link is published before copying, but failed copies never become media-ready', async()=>{
 const source={name:'video.mov',sizeBytes:4,md5Hash:Buffer.from('1234567890abcdef').toString('base64')};
 const events=[];
 const bucket={file:()=>({download:async()=>{events.push('download');throw Error('Source temporarily unavailable');}})};
 const {mirrorSessionToDriveBridge}=delivery([],bucket,async(url,options)=>{
  const action=JSON.parse(options.body).action;events.push(action);
  return {ok:true,json:async()=>({ok:true,transferMode:'direct-v1',folderUrl:'https://drive.google.com/drive/folders/test',transfers:[{...source,nextOffset:0,uploadUrl:'https://www.googleapis.com/upload/drive/v3/files?upload_id=test'}]})};
 });
 await assert.rejects(mirrorSessionToDriveBridge({bucket,files:[source],sessionLabel:'test',onFolderReady:async url=>{assert.match(url,/folders\/test$/);events.push('folder');},onMediaReady:async()=>events.push('ready')}),/temporarily unavailable/);
 assert.deepEqual(events,['prepare','folder','download','release']);
});

test('lost prepare responses release only their own lease instead of waiting ten minutes',async()=>{
 const calls=[];
 const {mirrorSessionToDriveBridge}=delivery([],{},async(url,options)=>{
  const body=JSON.parse(options.body);calls.push(body);
  if(body.action==='prepare')throw Error('fetch failed');
  return {ok:true,json:async()=>({ok:true})};
 });
 await assert.rejects(mirrorSessionToDriveBridge({files:[],sessionLabel:'test'}),error=>error.message==='fetch failed' && error.driveStage==='prepare');
 assert.deepEqual(calls.map(c=>c.action),['prepare','release']);
 assert.ok(calls[0].leaseId);assert.equal(calls[0].leaseId,calls[1].leaseId);
});

test('untrusted folder URLs are never published',async()=>{
 let published=false;
 const {mirrorSessionToDriveBridge}=delivery([],{},async()=>({ok:true,json:async()=>({ok:true,transferMode:'direct-v1',folderUrl:'https://evil.example/drive/folders/test',transfers:[]})}));
 await assert.rejects(mirrorSessionToDriveBridge({files:[],onFolderReady:async()=>{published=true;}}),/Invalid Drive folder/);
 assert.equal(published,false);
});
