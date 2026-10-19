'use strict';

// All records and original media remain private. Only this service projects
// published posts into the public feed; tips are never imported implicitly.
const {randomUUID, randomBytes, createHash, createHmac} = require('node:crypto');
const SITE = 'https://www.chriscerney.org';
const MEDIA_ENDPOINT = 'https://us-west1-tip-line-8c2d7.cloudfunctions.net/newsMedia';
const TYPES = new Set(['image/jpeg','image/png','image/webp','image/avif','video/mp4','video/webm']);
const MAX_FILE = 2 * 1024 ** 3;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const text = (value, max, required=false) => {
    if (value === undefined || value === null) value = '';
    if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail(400,'A text field is invalid or too long.');
    value = value.trim();
    if (required && !value) fail(400,'Add a headline before saving.');
    return value;
};
function isPublic(post, now=Date.now()) {
    return post?.status === 'published' && Number.isFinite(Date.parse(post.publishAt)) && Date.parse(post.publishAt) <= now;
}
function mediaUrl(postId, mediaId) {
    return `${MEDIA_ENDPOINT}?post=${postId}&media=${mediaId}`;
}
function publicPost(post) {
    return {id:post.id, title:post.title, caption:post.caption, location:post.location, topic:post.topic,
        publishAt:post.publishAt, updatedAt:post.updatedAt, permalink:`${SITE}/news/?post=${post.id}`,
        media:post.media.map(m=>({id:m.id, type:m.type, alt:m.alt || post.title, url:mediaUrl(post.id,m.id)}))};
}
function rangeRequest(value, size) {
    if (!value) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(value);
    if (!match || (!match[1] && !match[2])) fail(416,'Invalid byte range.');
    let start = match[1] ? Number(match[1]) : Math.max(0,size-Number(match[2]));
    let end = match[1] ? (match[2] ? Math.min(size-1,Number(match[2])) : size-1) : size-1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) fail(416,'Invalid byte range.');
    return {start,end};
}

function createNewsService({store, media, sendEmail, secret, now=Date.now}) {
    const stamp = () => new Date(now()).toISOString();
    const memberId = email => createHmac('sha256',secret()).update('news-member:'+email).digest('hex');
    async function mutate(key, transform) {
        for (let attempt=0; attempt<8; attempt++) {
            const old = await store.read(key);
            const next = await transform(old?.data);
            try { await store.write(key,next,old?.generation || 0); return next; }
            catch(error) { if (Number(error.code)!==412 || attempt===7) throw error; }
        }
    }
    const catalog = async () => (await store.read('catalog.json'))?.data || {posts:[]};
    const admin = body => { if (body.admin !== true) fail(401,'Sign in as the administrator.'); };
    async function limit(key, maximum, duration) {
        await mutate('limits/'+hash(key)+'.json', old=>{
            const state = old && old.until > now() ? old : {count:0,until:now()+duration};
            if (state.count >= maximum) fail(429,'Too many requests. Please try again later.');
            return {...state,count:state.count+1};
        });
    }
    async function member(token) {
        if (!TOKEN.test(token || '')) return null;
        const session = (await store.read('sessions/'+hash(token)+'.json'))?.data;
        if (!session || session.expiresAt <= now()) return null;
        const record = (await store.read('members/'+session.memberId+'.json'))?.data;
        if (!record?.email || record.deletedAt || session.createdAt <= (record.revokedBefore || 0)) return null;
        return record;
    }
    const memberView = record => record ? {authenticated:true,email:record.email,updates:record.updates,saved:record.saved || []} : {authenticated:false};
    async function upload(body) {
        admin(body);
        if (!TYPES.has(body.type) || !Number.isSafeInteger(body.size) || body.size <= 0 || body.size > MAX_FILE
            || (body.type.startsWith('image/') && body.size > 30*1024**2)) fail(400,'Use JPG, PNG, WebP, AVIF, MP4 or WebM. Photos: 30 MB; videos: 2 GB.');
        const id=randomUUID();
        const record={id,type:body.type,size:body.size,name:text(body.name,200),createdAt:stamp()};
        await store.write('uploads/'+id+'.json',record,0);
        const uri=await media.begin(record);
        return {id,uri};
    }
    async function save(body) {
        admin(body);
        if (!ID.test(body.id || '')) fail(400,'Invalid post identifier.');
        const title=text(body.title,180,true), caption=text(body.caption,10000), location=text(body.location,120), topic=text(body.topic,50);
        if (!['draft','published'].includes(body.status)) fail(400,'Choose draft or publish.');
        if (!Array.isArray(body.media) || body.media.length>10) fail(400,'Choose up to 10 photos or videos.');
        if (new Set(body.media.map(m=>m.id)).size !== body.media.length) fail(400,'A media file was selected more than once.');
        const verified=[];
        for (const selected of body.media) {
            if (!ID.test(selected?.id || '')) fail(400,'Invalid media identifier.');
            const record=(await store.read('uploads/'+selected.id+'.json'))?.data;
            if (!record) fail(400,'Upload the selected media first.');
            const metadata=await media.inspect(record.id);
            if (Number(metadata.size)!==record.size || metadata.contentType!==record.type || !metadata.generation) fail(400,'A media upload is incomplete. Finish uploading before saving.');
            verified.push({...record,generation:String(metadata.generation),alt:text(selected.alt,500)});
        }
        const previous=(await catalog()).posts.find(p=>p.id===body.id);
        const publishAt=body.publishAt || (previous?.status==='published' ? previous.publishAt : null) || stamp();
        if (!Number.isFinite(Date.parse(publishAt)) || Date.parse(publishAt)>now()+366*86400000) fail(400,'Choose a valid publication date within one year.');
        // A published post keeps its original timestamp on ordinary edits.
        const draft={id:body.id,title,caption,location,topic,status:body.status,publishAt:new Date(publishAt).toISOString(),
            media:verified,notify:body.notify===true,updatedAt:stamp()};
        let saved;
        await mutate('catalog.json', old=>{
            const state=old || {posts:[]};
            const existing=state.posts.find(p=>p.id===body.id);
            if (Number(body.revision || 0)!==Number(existing?.revision || 0)) fail(409,'This post changed in another window. Reload it before saving.');
            if (!existing && state.posts.length>=1000) fail(409,'The first-release archive limit is reached. Export the archive before expanding it.');
            saved={...draft,createdAt:existing?.createdAt || stamp(),revision:(existing?.revision || 0)+1};
            return {posts:[saved,...state.posts.filter(p=>p.id!==body.id)]};
        });
        return {post:saved};
    }
    async function signIn(body) {
        const email=text(body.email,254).toLowerCase();
        if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email)) fail(400,'Enter a valid email address.');
        if (body.consent !== true) fail(400,'Confirm that you agree to create or access your free account.');
        await limit('ip:'+body.clientKey,6,3600000);
        await limit('email:'+memberId(email),3,3600000);
        await limit('all-signins',100,3600000);
        const token=randomBytes(32).toString('base64url');
        const record={email,memberId:memberId(email),updates:body.updates===true,createdAt:now(),expiresAt:now()+15*60000,used:false};
        await store.write('links/'+hash(token)+'.json',record,0);
        await sendEmail({to:email,subject:'Your Chris Cerney sign-in link',text:
            `Use this link to sign in or join Chris Cerney's news platform:\n\n${SITE}/news/#signin=${token}\n\nThis link expires in 15 minutes and can be used once. If you did not request it, you can ignore this email.`,key:'news-signin-'+hash(token)});
        return {sent:true};
    }
    async function confirm(body) {
        if (!TOKEN.test(body.link || '')) fail(400,'This sign-in link is invalid.');
        const key='links/'+hash(body.link)+'.json';
        // A browser retry uses the same random exchange ID, recovering a lost
        // response without permitting a second browser to reuse the link.
        if (!TOKEN.test(body.exchange || '')) fail(400,'Invalid sign-in request.');
        const claim=await mutate(key, old=>{
            if (!old || old.expiresAt<=now() || (old.used && old.exchangeHash!==hash(body.exchange))) fail(400,'This link has expired or has already been used. Request a new link.');
            return {...old,used:true,exchangeHash:hash(body.exchange)};
        });
        const record=await mutate('members/'+claim.memberId+'.json', old=>{
            if (old?.deletedAt && claim.createdAt <= old.deletedAt) fail(400,'Request a new sign-in link.');
            if (old?.email && !old.deletedAt) return old; // A login never changes existing consent.
            return {id:claim.memberId,email:claim.email,updates:claim.updates,saved:[],joinedAt:stamp(),consentedAt:stamp(),consentVersion:'2026-10-19',
                revokedBefore:Math.max(old?.deletedAt || 0,old?.revokedBefore || 0),unsubscribe:randomBytes(32).toString('base64url')};
        });
        const sessionToken=createHmac('sha256',secret()).update('news-exchange:'+body.link+':'+body.exchange).digest('base64url');
        const sessionKey='sessions/'+hash(sessionToken)+'.json';
        try { await store.write(sessionKey,{memberId:record.id,createdAt:now(),expiresAt:now()+30*86400000},0); }
        catch(error) { if (Number(error.code)!==412) throw error;
            const existing=(await store.read(sessionKey))?.data;
            if (!existing || existing.expiresAt<=now()) fail(400,'This session has ended. Request a new sign-in link.');
        }
        await store.write('unsubscribes/'+hash(record.unsubscribe)+'.json',{memberId:record.id});
        return {...memberView(record),sessionToken};
    }
    async function handle(body) {
        if (body.op==='feed') {
            let posts=(await catalog()).posts.filter(p=>isPublic(p,now())).sort((a,b)=>Date.parse(b.publishAt)-Date.parse(a.publishAt) || a.id.localeCompare(b.id));
            if (body.id) posts=posts.filter(p=>p.id===body.id);
            if (['video','image'].includes(body.type)) posts=posts.filter(p=>p.media.some(m=>m.type.startsWith(body.type+'/')));
            if (body.query) { const q=text(body.query,100).toLowerCase();posts=posts.filter(p=>[p.title,p.caption,p.location,p.topic].join(' ').toLowerCase().includes(q)); }
            const offset=Math.max(0,Math.min(1000,Number(body.offset)||0));
            return {posts:posts.slice(offset,offset+30).map(publicPost),nextOffset:posts.length>offset+30 ? offset+30 : null};
        }
        if (body.op==='admin-list') {
            admin(body);
            const state=await catalog();
            return {posts:state.posts.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),maxFileBytes:MAX_FILE};
        }
        if (body.op==='admin-upload') return upload(body);
        if (body.op==='admin-save') return save(body);
        if (body.op==='admin-preview') {
            admin(body);
            if (!ID.test(body.id || '')) fail(400,'Invalid media identifier.');
            const expires=now()+15*60000;
            const signature=createHmac('sha256',secret()).update(`news-preview:${body.id}:${expires}`).digest('hex');
            return {url:`${MEDIA_ENDPOINT}?media=${body.id}&expires=${expires}&signature=${signature}`};
        }
        if (body.op==='admin-export') {
            admin(body);
            const records=await store.list('members/');
            return {posts:(await catalog()).posts,members:records.filter(r=>r.email && !r.deletedAt).map(r=>({email:r.email,updates:r.updates,joinedAt:r.joinedAt,consentedAt:r.consentedAt}))};
        }
        if (body.op==='signin') return signIn(body);
        if (body.op==='confirm') return confirm(body);
        if (body.op==='unsubscribe') {
            if (!TOKEN.test(body.token || '')) fail(400,'Invalid unsubscribe link.');
            const data=(await store.read('unsubscribes/'+hash(body.token)+'.json'))?.data;
            if (!data) fail(400,'Invalid unsubscribe link.');
            await mutate('members/'+data.memberId+'.json', old=>old?.email ? {...old,updates:false,unsubscribedAt:stamp()} : old || {});
            return {unsubscribed:true};
        }
        const current=await member(body.session);
        if (body.op==='status') return memberView(current);
        if (!current) fail(401,'Join or sign in to save stories.');
        if (body.op==='saved-feed') return {posts:(await catalog()).posts.filter(p=>isPublic(p,now()) && current.saved?.includes(p.id)).sort((a,b)=>current.saved.indexOf(a.id)-current.saved.indexOf(b.id)).map(publicPost),nextOffset:null};
        if (body.op==='save-story') {
            if (!ID.test(body.id || '') || !(await catalog()).posts.some(p=>p.id===body.id && isPublic(p,now()))) fail(404,'This story is unavailable.');
            const record=await mutate('members/'+current.id+'.json', old=>{
                if (!old?.email || old.deletedAt) fail(401,'Sign in again.');
                const saved=(old.saved || []).filter(id=>id!==body.id);
                if (body.saved===true) saved.unshift(body.id);
                return {...old,saved:saved.slice(0,500)};
            });
            return memberView(record);
        }
        if (body.op==='preferences') {
            const record=await mutate('members/'+current.id+'.json', old=>{
                if (!old?.email || old.deletedAt) fail(401,'Sign in again.');
                return {...old,updates:body.updates===true,consentedAt:stamp()};
            });
            return memberView(record);
        }
        if (body.op==='logout') {
            await store.write('sessions/'+hash(body.session)+'.json',{expiresAt:0});
            return {authenticated:false};
        }
        if (body.op==='delete-account') {
            await mutate('members/'+current.id+'.json',()=>({id:current.id,deletedAt:now()}));
            return {authenticated:false};
        }
        fail(400,'Unknown request.');
    }
    async function deliverUpdates() {
        const posts=(await catalog()).posts.filter(p=>isPublic(p,now()) && p.notify && now()-Date.parse(p.publishAt)<7*86400000).sort((a,b)=>a.publishAt.localeCompare(b.publishAt));
        if (!posts.length) return {sent:0};
        const members=(await store.list('members/')).filter(r=>r.email && !r.deletedAt && r.updates);
        let processed=0,sent=0;
        for (const post of posts) for (const subscriber of members) {
            if (Date.parse(subscriber.joinedAt)>Date.parse(post.publishAt) || processed>=20) continue;
            const key=`deliveries/${post.id}-${subscriber.id}.json`,lease=randomUUID();
            let claimed=false;
            await mutate(key, old=>{
                claimed=false;
                if (old?.sent || old?.reviewRequired || old?.nextAttempt>now()) return old;
                if (old?.firstAttempt && now()-old.firstAttempt>23*3600000) return {...old,reviewRequired:true};
                claimed=true;
                return {...old,firstAttempt:old?.firstAttempt || now(),attempt:(old?.attempt || 0)+1,lease,nextAttempt:now()+5*60000};
            });
            if (!claimed) continue;
            processed++;
            const fresh=(await store.read('members/'+subscriber.id+'.json'))?.data;
            const live=(await catalog()).posts.find(p=>p.id===post.id);
            if (!fresh?.updates || fresh.deletedAt || !isPublic(live,now()) || !live.notify) continue;
            try {
                await sendEmail({to:fresh.email,subject:live.title,text:`${live.title}\n\n${live.caption}\n\nRead and watch: ${SITE}/news/?post=${live.id}\n\nChris Cerney — independent reporting\nYou opted in to news updates at chriscerney.org.\nUnsubscribe: ${SITE}/news/#unsubscribe=${fresh.unsubscribe}`,key:`news-post-${post.id}-${subscriber.id}`});
                await mutate(key, old=>old?.lease===lease ? {...old,sent:true,sentAt:stamp()} : old);
                sent++;
            } catch {
                await mutate(key, old=>old?.lease===lease ? {...old,nextAttempt:now()+Math.min(3600000,60000*2**Math.min(old.attempt,6))} : old);
            }
        }
        return {sent,processed};
    }
    return {handle,deliverUpdates,catalog,member,mutate};
}
module.exports={createNewsService,isPublic,publicPost,rangeRequest,ID,TYPES,MAX_FILE,SITE,MEDIA_ENDPOINT,hash};
