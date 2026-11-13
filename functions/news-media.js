'use strict';
const {createHmac,timingSafeEqual}=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {ID,SITE,isPublic}=require('./news-core');
const {HLS,QUALITY_ID,masterPlaylist,signedPlaylist}=require('./news-video-core');

// Small published images keep a stable URL and can be reused on the device.
// Previews, unpublished material, and large/ranged media keep the existing path.
function createNewsMediaHandler({catalog,readUpload,fileFor,previewSecret,readRenditions=async()=>null,fileForRendition,now=Date.now}) {
    return async(req,res)=>{
        res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':SITE,'Accept-Ranges':'bytes'});
        if (!['GET','HEAD'].includes(req.method)) return res.status(405).end();
        const id=String(req.query.media || '');
        if (!ID.test(id)) return res.status(404).end();
        try {
            let record,preview=false;
            const expires=String(req.query.expires || ''),signature=String(req.query.signature || '');
            if (/^\d{13}$/.test(expires) && Number(expires)>now() && Number(expires)<=now()+16*60000 && /^[a-f0-9]{64}$/.test(signature)) {
                const expected=createHmac('sha256',previewSecret()).update(`news-preview:${id}:${expires}`).digest();
                if (timingSafeEqual(expected,Buffer.from(signature,'hex'))) {
                    record=await readUpload(id);
                    preview=Boolean(record);
                }
            }
            if (!record) {
                const post=(await catalog()).posts.find(p=>p.id===req.query.post && isPublic(p,now()));
                record=post?.media.find(item=>item.id===id);
            }
            if (!record) return res.status(404).end();
            const file=fileFor(record);
            const [metadata]=await file.getMetadata();
            if (Number(metadata.size)!==record.size || metadata.contentType!==record.type || !metadata.generation || (record.generation && String(record.generation)!==String(metadata.generation))) return res.status(404).end();
            if(req.query.variant!==undefined) {
                const variant=String(req.query.variant);
                if(preview||!(variant==='adaptive'||QUALITY_ID.test(variant)))return res.status(404).end();
                const data=await readRenditions(record);
                if(!data)return res.status(404).end();
                let playlist;
                if(variant==='adaptive')playlist=masterPlaylist(req.query.post,id,data);
                else {
                    const level=data.levels.find(v=>v.id===variant);
                    if(!level||!fileForRendition)return res.status(404).end();
                    const asset=fileForRendition(record,level),[assetMetadata]=await asset.getMetadata();
                    if(String(assetMetadata.generation)!==level.generation||Number(assetMetadata.size)!==level.bytes||assetMetadata.contentType!=='video/mp4')return res.status(404).end();
                    const [url]=await asset.getSignedUrl({version:'v4',action:'read',expires:now()+15*60000,queryParams:{generation:level.generation}});
                    playlist=signedPlaylist(level,url);
                }
                res.set({'Content-Type':HLS,'Content-Length':String(Buffer.byteLength(playlist))});
                return req.method==='HEAD'?res.status(200).end():res.status(200).send(playlist);
            }
            const smallPublicImage=!preview && record.type.startsWith('image/') && record.size<=1024**2 && !req.headers.range;
            if (smallPublicImage) {
                const etag='"news-'+id+'-'+metadata.generation+'"';
                // Cache only in the reader's device, for five minutes. A later
                // request still checks publication before revalidating the ETag.
                res.set({'Cache-Control':'private, max-age=300, must-revalidate','Content-Type':record.type,'ETag':etag,'Timing-Allow-Origin':SITE});
                if (req.headers['if-none-match']===etag) return res.status(304).end();
                res.set('Content-Length',String(record.size));
                if (req.method==='HEAD') return res.status(200).end();
                await pipeline(file.createReadStream(),res);
                return;
            }
            if (req.method==='HEAD') {
                res.set('Content-Type',record.type);res.set('Content-Length',String(record.size));
                return res.status(200).end();
            }
            // Storage still serves large originals and video byte ranges.
            const [url]=await file.getSignedUrl({version:'v4',action:'read',expires:now()+15*60000,
                queryParams:record.generation ? {generation:record.generation} : {}});
            return res.redirect(302,url);
        } catch {
            if (!res.headersSent) {res.set('Cache-Control','private, no-store');return res.status(404).end();}
            res.destroy();
        }
    };
}
module.exports={createNewsMediaHandler};
