const test=require('node:test');
const assert=require('node:assert/strict');
const {transferToDrive}=require('./drive-transfer');
const base={uploadUrl:'https://www.googleapis.com/upload/drive/v3/files?upload_id=test',sizeBytes:10,nextOffset:4,md5Hash:Buffer.from('1234567890123456').toString('base64')};
const completed={id:'file',size:'10',md5Checksum:Buffer.from(base.md5Hash,'base64').toString('hex')};
test('direct transfer resumes at Drive acknowledged offset and checks final integrity',async()=>{
 const ranges=[];let calls=0;
 const result=await transferToDrive(base,async(start,end)=>{ranges.push([start,end]);return Buffer.alloc(end-start+1);},{fetchImpl:async()=>++calls===1?{status:308,headers:new Headers({range:'bytes=0-7'})}:{status:200,json:async()=>completed}});
 assert.deepEqual(ranges,[[4,9],[8,9]]);assert.equal(result.id,'file');
});
test('direct transfer rejects incomplete reads and corrupted completion',async()=>{
 await assert.rejects(transferToDrive(base,async()=>Buffer.alloc(1)),/incomplete/);
 await assert.rejects(transferToDrive(base,async()=>Buffer.alloc(6),{fetchImpl:async()=>({status:200,json:async()=>({...completed,md5Checksum:'wrong'})})}),/checksum/);
});
test('direct transfer refuses other destinations or unacknowledged data',async()=>{
 await assert.rejects(transferToDrive({...base,uploadUrl:'https://example.com/'},()=>{}),/destination/);
 await assert.rejects(transferToDrive(base,async()=>Buffer.alloc(6),{fetchImpl:async()=>({status:308,headers:new Headers()})}),/acknowledge/);
});
