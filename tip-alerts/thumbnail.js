'use strict';
// Private render previews live only in this page. Never persist images, expose
// a storage URL, or fall back to a submitted photo/video when a draft is absent.
class TipThumbnails {
    constructor(request) {
        this.request=request; this.version=0; this.active=0; this.queue=[];
        this.entries=new Map(); this.controllers=new Set(); this.urls=new Set();
        this.observer='IntersectionObserver' in window ? new IntersectionObserver(entries=>{
            for(const item of entries) if(item.isIntersecting) {
                this.observer.unobserve(item.target);
                const entry=this.entries.get(item.target);
                if(entry) this.enqueue(entry);
            }
            this.pump();
        },{rootMargin:'240px 0px'}) : null;
    }
    static descriptor(value) {
        return value && value.version===1 && /^[0-9]{1,30}$/.test(value.generation)
            && typeof value.generation==='string' && /^[a-f0-9]{64}$/.test(value.sha256)
            && Number.isSafeInteger(value.revision) && value.revision>=1
            && Number.isSafeInteger(value.contextVersion) && value.contextVersion>=0
            && Number.isInteger(value.width) && value.width>0 && value.width<=1600
            && Number.isInteger(value.height) && value.height>0 && value.height<=900;
    }
    add(tip,row) {
        if(!['ready','approved'].includes(tip.reportState) || !/^[a-f0-9]{64}$/.test(tip.id || '')
            || !TipThumbnails.descriptor(tip.thumbnail)) return;
        const descriptor={...tip.thumbnail};
        const figure=document.createElement('figure'); figure.className='tip-thumbnail';
        figure.style.aspectRatio=`${descriptor.width} / ${descriptor.height}`;
        const img=document.createElement('img'); img.alt='Rendered draft banner preview';
        img.width=descriptor.width; img.height=descriptor.height; img.decoding='async'; img.hidden=true;
        const placeholder=document.createElement('span'); placeholder.className='thumbnail-loading';
        placeholder.textContent='Loading draft preview…'; figure.append(img,placeholder); row.prepend(figure);
        const entry={id:tip.id,descriptor,figure,img,placeholder,version:this.version,queued:false,
            loading:false,loaded:false,attempts:0,retryable:false,retryTimer:null};
        this.entries.set(figure,entry);
        if(this.observer) this.observer.observe(figure);
        else this.enqueue(entry);
    }
    current(entry) { return entry.version===this.version && this.entries.get(entry.figure)===entry; }
    enqueue(entry) {
        if(!this.current(entry) || entry.queued || entry.loading || entry.loaded) return;
        clearTimeout(entry.retryTimer); entry.retryTimer=null;
        entry.queued=true; entry.retryable=false; entry.figure.hidden=false;
        this.queue.push(entry); this.pump();
    }
    retryFailed({manual=false}={}) {
        if(!manual) return;
        for(const entry of this.entries.values()) if(entry.retryable && !entry.loading && !entry.queued) {
            // A deliberate refresh starts a new bounded attempt cycle even when
            // the tip descriptor has not changed since the failed request.
            entry.attempts=0; this.enqueue(entry);
        }
    }
    reset() {
        this.version++; this.observer?.disconnect(); this.queue=[];
        for(const controller of this.controllers) controller.abort();
        for(const entry of this.entries.values()) { clearTimeout(entry.retryTimer); entry.img.removeAttribute('src'); entry.figure.remove(); }
        for(const url of this.urls) URL.revokeObjectURL(url);
        this.urls.clear(); this.entries.clear();
    }
    pump() {
        while(this.active<2 && this.queue.length) {
            const entry=this.queue.shift();
            if(!this.current(entry)) continue;
            entry.queued=false; entry.loading=true; entry.attempts++; this.active++;
            this.load(entry).finally(()=>{entry.loading=false; this.active--; this.pump();});
        }
    }
    async load(entry) {
        const controller=new AbortController(); this.controllers.add(controller);
        let timedOut=false,requestPending=true;
        const timeout=setTimeout(()=>{timedOut=true;controller.abort();},15000);
        let url;
        try {
            const d=entry.descriptor;
            const result=await this.request('thumbnail',{id:entry.id,generation:d.generation,
                sha256:d.sha256,revision:d.revision,contextVersion:d.contextVersion},{signal:controller.signal});
            requestPending=false;
            if(!this.current(entry)) return;
            const value=result.thumbnail;
            if(!TipThumbnails.descriptor(value) || value.mimeType!=='image/jpeg'
                || ['version','generation','sha256','revision','contextVersion','width','height'].some(key=>value[key]!==d[key])
                || typeof value.base64!=='string' || value.base64.length>349528
                || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)) throw new Error('Invalid preview');
            const bytes=Uint8Array.from(atob(value.base64),char=>char.charCodeAt(0));
            if(bytes.length<4 || bytes.length>262144 || bytes[0]!==255 || bytes[1]!==216
                || bytes[2]!==255 || bytes[bytes.length-2]!==255 || bytes[bytes.length-1]!==217) throw new Error('Invalid JPEG');
            const digest=await crypto.subtle.digest('SHA-256',bytes);
            const hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
            if(hash!==d.sha256) throw new Error('Preview changed');
            if(!this.current(entry)) return;
            controller.signal.throwIfAborted();
            url=URL.createObjectURL(new Blob([bytes],{type:'image/jpeg'})); this.urls.add(url);
            await new Promise((resolve,reject)=>{
                entry.img.onload=()=>resolve(); entry.img.onerror=()=>reject(new Error('Preview unavailable'));
                controller.signal.addEventListener('abort',()=>reject(new Error('Preview cancelled')),{once:true});
                entry.img.src=url;
            });
            if(!this.current(entry)) return;
            if(entry.img.naturalWidth!==d.width || entry.img.naturalHeight!==d.height) throw new Error('Preview dimensions changed');
            entry.loaded=true; entry.img.hidden=false; entry.placeholder.remove();
        } catch(error) {
            // Keep the tip and its Drive link usable if its current draft preview
            // is missing, replaced, unavailable, or its session was revoked.
            if(this.current(entry)) {
                const transient=timedOut || (requestPending && (error?.name==='TypeError'
                    || error?.name==='TimeoutError' || error?.status===408 || error?.status===429
                    || (error?.status>=500 && error.status<=599)));
                entry.img.removeAttribute('src'); entry.img.hidden=true;
                if(transient) {
                    entry.figure.hidden=true; entry.retryable=true;
                    // Three total attempts, with 2s then 6s backoff. Keep the
                    // failed entry so pull-to-refresh can recover after the cap.
                    if(entry.attempts<3) entry.retryTimer=setTimeout(()=>{
                        entry.retryTimer=null; this.enqueue(entry);
                    },2000*3**(entry.attempts-1));
                } else { entry.figure.remove(); this.entries.delete(entry.figure); }
            }
            if(url) { URL.revokeObjectURL(url); this.urls.delete(url); }
        } finally {
            clearTimeout(timeout); this.controllers.delete(controller);
            entry.img.onload=null; entry.img.onerror=null;
        }
    }
}
