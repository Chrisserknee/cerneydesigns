const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function bridge(extra = {}) {
    const context = vm.createContext({ console, ...extra });
    vm.runInContext(fs.readFileSync(__dirname + '/../upload/drive-bridge-apps-script.gs', 'utf8'), context);
    return context;
}
test('an interrupted Drive copy resumes at the server offset and clears its saved session only after verification', () => {
    let created = 0, deleted = 0, range;
    const properties = { getProperty: () => JSON.stringify({ uploadUrl: 'https://www.googleapis.com/upload/test' }), setProperty() {}, deleteProperty() { deleted++; } };
    const c = bridge({ PropertiesService: { getScriptProperties: () => properties }, DriveApp: { getFolderById: () => ({ getFilesByName: () => ({ hasNext: () => false }) }) } });
    c.hash_ = () => 'state'; c.md5Base64ToHex_ = () => 'checksum';
    c.queryDriveUpload_ = () => ({ nextOffset: 5242880 });
    c.startDriveUpload_ = () => { created++; };
    c.fetchWithRetry_ = (_, options) => { range = options.headers.Range; return { getResponseCode: () => 206, getBlob: () => ({ getBytes: () => ({ length: 10 }) }) }; };
    c.uploadDriveChunk_ = () => ({ complete: true, id: 'verified' });
    c.verifyDriveFile_ = () => ({ verified: true, id: 'verified' });
    const result = c.mirrorFile_({ url: 'https://firebasestorage.googleapis.com/v0/b/tip-line-8c2d7.firebasestorage.app/o/file', name: '01_video.mov', sizeBytes: 5242890 }, 'folder', 'session', Date.now());
    assert.equal(range, 'bytes=5242880-5242889');
    assert.equal(created, 0); assert.equal(deleted, 1); assert.equal(result.verified, true);
});
test('Drive verification uses REST metadata and rejects a different checksum', () => {
    const c = bridge({ Utilities: { sleep() {} } });
    c.driveMetadata_ = () => ({ size: '100', md5Checksum: 'abc' });
    assert.equal(c.verifyDriveFile_('id', 'video', 100, 'abc').verified, true);
    assert.throws(() => c.verifyDriveFile_('id', 'video', 100, 'wrong'), /checksum check failed/);
});
test('overlapping bridge executions cannot start another copy', () => {
    let copied = false;
    const c = bridge({ LockService: { getScriptLock: () => ({ tryLock: () => false }) } });
    c.verifyToken_ = () => {}; c.json_ = value => value; c.mirrorFile_ = () => { copied = true; };
    const result = c.doPost({ postData: { contents: '{}' } });
    assert.equal(result.ok, false); assert.match(result.error, /in progress/); assert.equal(copied, false);
});
test('Drive resume status is read as HTTP 308 rather than followed as a redirect', () => {
    let options;
    const c = bridge({ ScriptApp: { getOAuthToken: () => 'test' }, UrlFetchApp: { fetch(_, value) { options = value; return { getResponseCode: () => 308, getAllHeaders: () => ({ Range: 'bytes=0-5242879' }) }; } } });
    const result = c.queryDriveUpload_('https://www.googleapis.com/upload/test', 10000000);
    assert.equal(options.followRedirects, false); assert.equal(result.nextOffset, 5242880);
});
test('direct preparation resumes saved uploads and leases prevent duplicate writers',()=>{
 const saved=new Map([['upload_state',JSON.stringify({uploadUrl:'https://www.googleapis.com/upload/test'})]]);
 const props={getProperty:k=>saved.get(k),setProperty:(k,v)=>saved.set(k,v),deleteProperty:k=>saved.delete(k)};
 const folder={getId:()=> 'folder',getUrl:()=> 'folder-url',getFilesByName:()=>({hasNext:()=>false})};
 const c=bridge({PropertiesService:{getScriptProperties:()=>props}});
 c.hash_=()=> 'state';c.md5Base64ToHex_=()=> 'hash';c.queryDriveUpload_=()=>({nextOffset:8});
 c.startDriveUpload_=()=>{throw new Error('must reuse session');};
 const payload={leaseId:'owner',sessionLabel:'session',files:[{name:'video',sizeBytes:10,md5Hash:'x'}]};
 const result=c.prepareTransfers_(payload,folder);
 assert.equal(result.transfers[0].nextOffset,8);
 assert.throws(()=>c.prepareTransfers_({...payload,leaseId:'other'},folder),/in progress/);
 c.releaseTransfer_({...payload,leaseId:'other'},folder);
 assert.throws(()=>c.checkTransferLease_({leaseId:'other'},folder),/in progress/);
 c.releaseTransfer_(payload,folder);assert.equal(saved.has('lease_folder'),false);
});
