'use strict';
// Preserve complete paragraphs; never leak unbounded objects or raw manifests.
function copyText(value,max){
 if(typeof value!=='string' || value.length>max)return '';
 return value.replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim();
}
function reportCopy(data){return {instagramDescription:copyText(data?.instagramDescription,2100),voiceover:copyText(data?.voiceover,6000)};}
module.exports={copyText,reportCopy};
