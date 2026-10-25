'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const core=require('../../functions-booking/sponsorship-core');
const {createHarness,drawingData}=require('./helpers/sponsorship-fixture.cjs');
test('a name without a drawn signature cannot unlock payment',async()=>{
    const h=createHarness(),{id}=await h.submit();await h.workflow.handle({op:'approve',id});
    const r=(await h.store.read()).orders[id],body={op:'sign',id,token:'a'.repeat(64),agreementHash:r.agreement.hash,signerName:'Test Client',signerTitle:'Owner',authorized:true,electronicConsent:true};
    for(const signatureDrawing of [undefined,{version:1,strokes:[]},{version:1,strokes:[[[0.1,0.1]]]}])await assert.rejects(h.workflow.handle({...body,signatureDrawing}));
    assert.equal((await h.store.read()).orders[id].status,'approved');
    await assert.rejects(h.workflow.handle({op:'checkout',id,token:'a'.repeat(64)}));assert.equal(h.metrics.issues,0);
});
test('signature data is numeric, bounded, and cannot carry executable markup',()=>{
    for(const value of [{version:2,strokes:drawingData.strokes},{version:1,strokes:[[['<svg>',0.2]]]},{version:1,strokes:[[[Infinity,0.2]]]},{version:1,strokes:[[[0.1,-0.2]]]},{version:1,strokes:[Array(1201).fill([0.1,0.2])]},'data:image/svg+xml;base64,xxx'])assert.throws(()=>core.signatureDrawing(value));
    assert.deepEqual(core.signatureDrawing(drawingData),drawingData);
});
test('the saved ink is bound to the agreement and stays unchanged on retries',async()=>{
    const h=createHarness(),{id}=await h.submit();const accepted=await h.workflow.handle({op:'approve',id});
    const first=await h.sign(id),again=await h.sign(id);
    assert.deepEqual(again.signature,first.signature);assert.deepEqual(first.signature.drawing,drawingData);
    assert.equal(first.signature.agreementHash,accepted.agreement.hash);assert.equal(first.signature.drawingHash,core.hash(JSON.stringify(drawingData)));
    await assert.rejects(h.workflow.handle({op:'sign',id,token:'a'.repeat(64),agreementHash:accepted.agreement.hash,signerName:'Test Client',signerTitle:'Owner',authorized:true,electronicConsent:true,signatureDrawing:{version:1,strokes:[[[0.15,0.6],[0.3,0.2],[0.4,0.7],[0.8,0.4]]]}}),e=>e.code===409);
    const stored=(await h.store.read()).orders[id].signature;assert.equal(stored.drawingHash,first.signature.drawingHash);
});
