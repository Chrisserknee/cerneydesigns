'use strict';
// Synthetic data and in-memory providers for isolated tests only.
const {createWorkflow,freshState,validateConfig}=require('../../../functions-booking/sponsorship-workflow');
const {slotInterval,overlaps}=require('../../../functions-booking/sponsorship-schedule');
const drawingData={version:1,strokes:[[[0.1,0.6],[0.2,0.2],[0.3,0.65],[0.4,0.25],[0.6,0.5],[0.85,0.4]]]};
const fixedNow=Date.parse('2026-10-14T12:00:00Z');
const packageData={title:'TEST video package',amount:50000,currency:'usd',durationMinutes:60,includes:'One test video',channels:'Test channel',turnaround:'Test turnaround',revisions:'One test revision',priceNote:'Test data only'};
const configData={enabled:true,timeZone:'America/Los_Angeles',calendarId:'owner@example.test',blockCalendarIds:['owner@example.test'],package:packageData,
    terms:{version:'test-v1',provider:'Test Provider',text:'SYNTHETIC TEST TERMS. Not a legal agreement.',approved:true},
    windows:[{date:'2026-10-20',start:'09:00',end:'17:00'}],bufferBefore:30,bufferAfter:30,leadHours:24};
function createHarness({recurringReady=true}={}){
    let state=freshState(),clock=fixedNow,ready=true,tail=Promise.resolve();state.config=validateConfig(structuredClone(configData),state.config);
    const metrics={holds:0,issues:0,confirmations:0},events=new Map(),invoices=new Map();
    const store={read:async()=>structuredClone(state),change:fn=>{
        const change=tail.then(()=>{const next=structuredClone(state),result=fn(next);state=next;return result;});tail=change.catch(()=>{});return change;
    }};
    const calendar={external:[],failure:null,confirmFailure:false,
        async busy(){if(this.failure)throw this.failure;return [...this.external,...[...events.values()].map(slotInterval)];},
        async hold(r){metrics.holds++;if(this.failure)throw this.failure;if(this.external.some(b=>overlaps(b,slotInterval(r.slot))))throw Object.assign(new Error('Calendar conflict'),{code:409});events.set(r.id,r.slot);},
        async verifyHold(r){if(this.failure)throw this.failure;if(!events.has(r.id)||this.external.some(b=>overlaps(b,slotInterval(r.slot))))throw Object.assign(new Error('Calendar conflict'),{code:409});},
        async confirm(r){metrics.confirmations++;if(this.confirmFailure)throw Object.assign(new Error('Calendar down'),{code:503});await this.verifyHold(r);}
    };
    const payments={async retrieve(id){return structuredClone(invoices.get(id));},async issue(r,save){
        const id='in_'+r.id;if(!invoices.has(id)){metrics.issues++;invoices.set(id,{id,number:'TEST-'+r.id,status:'open',currency:'usd',total:r.package.amount,amount_paid:0,hosted_invoice_url:'https://invoice.stripe.com/i/test_'+r.id,metadata:{sponsorshipId:r.id,agreementHash:r.agreement.hash}});}
        await save({invoice:{id,number:'TEST-'+r.id}});return structuredClone(invoices.get(id));
    }};
    const workflow=createWorkflow({store,calendar,payments,now:()=>clock,ready:()=>ready,recurringReady:()=>recurringReady});
    const submit=(token='a'.repeat(64),changes={})=>workflow.handle({op:'submit',token,clientKey:'e'.repeat(64),name:'Test Client',email:'client@example.test',business:'Test Business',businessDescription:'Synthetic business',brief:'A synthetic video brief',location:'Test studio',requestAcknowledged:true,slotStart:'2026-10-20T16:00:00.000Z',offerRevision:state.config.revision,...changes});
    const sign=(id,token='a'.repeat(64))=>workflow.handle({op:'sign',id,token,agreementHash:state.orders[id].agreement.hash,signerName:'Test Client',signerTitle:'Owner',signatureDrawing:structuredClone(drawingData),authorized:true,electronicConsent:true,recurringConsent:true,clientKey:'e'.repeat(64),userAgent:'test'});
    return {store,workflow,calendar,payments,events,invoices,metrics,submit,sign,setNow:value=>clock=value,setReady:value=>ready=value};
}
module.exports={createHarness,packageData,configData,fixedNow,drawingData};
