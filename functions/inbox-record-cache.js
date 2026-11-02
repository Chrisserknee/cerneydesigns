'use strict';
// Generation validation is always performed against a fresh storage listing.
// Bound by bytes as well as count, so growth does not repeatedly flush the inbox.
class InboxRecordCache {
    constructor({byteLimit=8*1024*1024,entryLimit=5000}={}){
        this.records=new Map();this.bytes=0;this.revision=0;this.byteLimit=byteLimit;this.entryLimit=entryLimit;
    }
    get(name){const entry=this.records.get(name);if(!entry)return undefined;this.records.delete(name);this.records.set(name,entry);return entry.value;}
    set(name,value,size){this.delete(name);if(size>this.byteLimit)return;
        this.records.set(name,{value,size});this.bytes+=size;this.revision++;
        while(this.bytes>this.byteLimit||this.records.size>this.entryLimit)this.delete(this.records.keys().next().value);
    }
    delete(name){const entry=this.records.get(name);if(entry){this.bytes-=entry.size;this.records.delete(name);this.revision++;}}
    keys(){return this.records.keys();}
    entries(){return [...this.records].map(([name,entry])=>[name,entry.value]);}
}
module.exports={InboxRecordCache};
