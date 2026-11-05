'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateProfile,profileMetadata,readProfile,publicProfileHash}=require('../api/_lib/spotlight');
const {profileFrom,profileHash}=require('../functions-spotlight/providers');
const base={businessName:'Example',category:'Professional Services',city:'Monterey',description:'Synthetic test.',website:'https://example.com/',phone:'',logoUrl:''};
test('optional address round-trips through signup metadata and moderation with matching approval hashes',()=>{
 const p=validateProfile({...base,address:'  123 Main St, Suite 2, Monterey, CA 93940  '});
 assert.equal(p.address,'123 Main St, Suite 2, Monterey, CA 93940');
 assert.deepEqual(readProfile(profileMetadata(p)),p);assert.deepEqual(profileFrom(profileMetadata(p)),p);
 assert.equal(publicProfileHash(p),profileHash(p));assert.notEqual(publicProfileHash(p),publicProfileHash(base));
 assert.notEqual(publicProfileHash({...p,address:'456 Main St'}),publicProfileHash(p));
 for(const address of [undefined,'','   ']){assert.deepEqual(validateProfile({...base,address}),base);assert.equal(publicProfileHash(validateProfile({...base,address})),publicProfileHash(base));assert.deepEqual(profileFrom({...profileMetadata(base),business_address:address}),base);}
});
test('address validation rejects malformed or oversized values in both public API and moderation',()=>{
 for(const address of ['x'.repeat(201),'<script>bad</script>','line\nline',42,{}]){assert.throws(()=>validateProfile({...base,address}));assert.throws(()=>profileFrom({...profileMetadata(base),business_address:address}));}
});
