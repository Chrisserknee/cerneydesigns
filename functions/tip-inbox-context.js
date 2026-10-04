'use strict';
// Only descriptive fields enter the private inbox. Never forward the manifest,
// contact fields, source identity, capabilities, or Claude's internal notes.
function text(value, limit) {
    return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,limit) : '';
}
function sourceContext(initial={}, followup) {
    const source=followup || initial;
    const summary=text(source.whatHappened || source.description,360);
    return {sourceTitle:text(summary,100),sourceSummary:summary,sourceLocation:text(source.location,140),
        contextReceivedAt:followup ? text(followup.receivedAt,40) : ''};
}
const states=new Set(['queued','analyzing','awaiting_editor','editing','rendering','qc_pending','ready','approved','needs_review','held','failed','declined','paused']);
function displayContext(tip, report) {
    const result={...tip,title:tip.sourceTitle || '',summary:tip.sourceSummary || '',location:tip.sourceLocation || '',contextSource:tip.sourceSummary?'tipster':'pending'};
    if (!report || report.version!==1 || report.source!==tip.path || report.id!==tip.id
        || (tip.sourceGeneration && String(report.sourceGeneration)!==String(tip.sourceGeneration))) return result;
    // Follow-up evidence takes priority until Claude has incorporated that version.
    const contextStale=tip.contextReceivedAt && Date.parse(report.sourceContextAt || '')<Date.parse(tip.contextReceivedAt);
    if (contextStale || (tip.contextReceivedAt && !report.sourceContextAt)) return result;
    result.reportState=states.has(report.state)?report.state:'processing';
    result.reportRevision=Number.isSafeInteger(report.revision)&&report.revision>0?report.revision:0;
    result.contextUpdatedAt=text(report.updatedAt,40);
    if (report.contextSource==='claude' && text(report.title,100)) {
        result.title=text(report.title,100);result.summary=text(report.summary,420);result.contextSource='claude';
    }
    return result;
}
module.exports={text,sourceContext,displayContext};
