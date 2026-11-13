'use strict';
const {mkdtemp,rm,stat}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createHash}=require('node:crypto');
const {createReadStream}=require('node:fs');
const {ID}=require('./news-core');
const {PIPELINE,sourceInfo,qualityLevels,probeSource,encodeLevel}=require('./news-video-core');
const {assetPath}=require('./news-video-delivery');
const ROOT='_news/v1/';
const MAX_ATTEMPTS=2;
const LEASE_MS=600000;
function eventTarget(object) {
    if(!object||typeof object.name!=='string'||!/^\d+$/.test(String(object.generation)))return null;
    const parts=object.name.split('/');
    if(parts.length===4&&parts[0]==='_news'&&parts[1]==='v1'&&parts[2]==='media'&&ID.test(parts[3])&&['video/mp4','video/webm'].includes(object.contentType)&&Number(object.size)>0&&Number(object.size)<=2*1024**3)return {kind:'source',id:parts[3],generation:String(object.generation)};
    if(parts.length===6&&parts[0]==='_news'&&parts[1]==='v1'&&parts[2]==='video-jobs'&&ID.test(parts[3])&&/^\d+$/.test(parts[4])&&/^q[1-9][0-9]{1,3}\.json$/.test(parts[5]))return {kind:'job',id:parts[3],generation:parts[4],quality:parts[5].slice(0,-5)};
    return null;
}
async function md5File(path) {
    const hash=createHash('md5');for await(const part of createReadStream(path))hash.update(part);return hash.digest('base64');
}
function createVideoProcessor({bucket,ffmpeg,ffprobe,probe=probeSource,encode=encodeLevel,now=Date.now}) {
    async function read(name) {
        try {const file=bucket.file(ROOT+name),[meta]=await file.getMetadata(),[bytes]=await bucket.file(ROOT+name,{generation:meta.generation}).download();return {data:JSON.parse(bytes.toString()),generation:meta.generation};}
        catch(error){if(Number(error.code)===404)return null;throw error;}
    }
    async function write(name,data,generation) {
        await bucket.file(ROOT+name).save(JSON.stringify(data),{resumable:false,contentType:'application/json',metadata:{cacheControl:'private,no-store'},preconditionOpts:{ifGenerationMatch:generation}});
    }
    async function mutate(name,transform) {
        for(let attempt=0;attempt<8;attempt++){
            const old=await read(name),next=await transform(old?.data);
            if(!next)return old?.data;
            try{await write(name,next,old?.generation||0);return next;}catch(error){if(Number(error.code)!==412||attempt===7)throw error;}
        }
    }
    const indexName=target=>`renditions/${target.id}/${target.generation}.json`;
    async function localSource(input,directory) {
        // Static Linux media binaries can crash in their DNS resolver. Let the
        // Storage SDK perform authenticated I/O, and give media tools local bytes.
        const path=join(directory,'source.mp4');
        await input.file.download({destination:path,validation:'md5'});
        if((await stat(path)).size!==input.size)throw Error('Downloaded source size mismatch');
        return path;
    }
    async function original(target) {
        const upload=(await read(`uploads/${target.id}.json`))?.data;
        if(!upload||upload.id!==target.id||!['video/mp4','video/webm'].includes(upload.type))throw Error('Unrecognized owner video');
        const file=bucket.file(ROOT+'media/'+target.id,{generation:target.generation}),[meta]=await file.getMetadata();
        if(Number(meta.size)!==upload.size||meta.contentType!==upload.type||String(meta.generation)!==target.generation)throw Error('Source generation mismatch');
        return {...upload,generation:target.generation,file};
    }
    async function prepare(target) {
        const input=await original(target),name=indexName(target);
        let index=(await read(name))?.data;
        if(!index){
            const claimName=`video-claims/${target.id}/${target.generation}/probe.json`;
            let acquired=false,directory;
            const claim=await mutate(claimName,old=>{
                acquired=false;
                if((old?.attempts||0)>=MAX_ATTEMPTS)return null;
                if(old?.status==='processing'&&old.expiresAt>now())throw Error('Video probe already running');
                acquired=true;return {status:'processing',attempts:(old?.attempts||0)+1,expiresAt:now()+LEASE_MS};
            });
            if(!acquired)return {status:'attempt-limit'};
            try {
                directory=await mkdtemp(join(tmpdir(),'cerney-news-probe-'));
                const inspected=await probe(await localSource(input,directory),ffprobe);
                let source;
                try{source=sourceInfo(inspected);}catch{
                    await mutate(name,old=>old||{pipeline:PIPELINE,mediaId:target.id,sourceGeneration:target.generation,sourceSize:input.size,status:'unsupported',levels:[]});
                    return {status:'original-only'};
                }
                index=await mutate(name,old=>old||{pipeline:PIPELINE,mediaId:target.id,sourceGeneration:target.generation,sourceSize:input.size,source,status:'processing',levels:[]});
                await mutate(claimName,current=>({...current,status:'complete'}));
            }catch(error){
                await mutate(claimName,current=>({...current,status:'failed',expiresAt:0}));
                if(claim.attempts<MAX_ATTEMPTS)throw Error('Video probe retry required');
                await mutate(name,old=>old||{pipeline:PIPELINE,mediaId:target.id,sourceGeneration:target.generation,sourceSize:input.size,status:'probe-failed',levels:[]});
                return {status:'failed'};
            }finally{
                if(directory)await rm(directory,{recursive:true,force:true});
            }
        }
        if(!index.source)return {status:'original-only'};
        for(const level of qualityLevels(index.source)) {
            if(index.levels.some(v=>v.id===level.id))continue;
            try{await write(`video-jobs/${target.id}/${target.generation}/${level.id}.json`,{pipeline:PIPELINE,mediaId:target.id,sourceGeneration:target.generation,quality:level.id},0);}
            catch(error){if(Number(error.code)!==412)throw error;}
        }
        return {status:'queued'};
    }
    async function process(target) {
        const name=indexName(target),index=(await read(name))?.data;
        if(!index?.source||index.pipeline!==PIPELINE)return {status:'ignored'};
        if(index.levels.some(v=>v.id===target.quality))return {status:'ready'};
        const level=qualityLevels(index.source).find(v=>v.id===target.quality);
        if(!level)return {status:'ignored'};
        const claimName=`video-claims/${target.id}/${target.generation}/${level.id}.json`;
        let acquired=false;
        const claim=await mutate(claimName,old=>{
            acquired=false;
            if(old?.status==='complete'||(old?.attempts||0)>=MAX_ATTEMPTS)return null;
            if(old?.status==='processing'&&old.expiresAt>now())throw Error('Video job already running');
            acquired=true;return {status:'processing',attempts:(old?.attempts||0)+1,expiresAt:now()+LEASE_MS};
        });
        if(!acquired)return {status:'attempt-limit'};
        let directory;
        try {
            const input=await original(target);
            if(input.size!==index.sourceSize)throw Error('Source changed');
            directory=await mkdtemp(join(tmpdir(),'cerney-news-video-'));
            const encoded=await encode({input:await localSource(input,directory),directory,source:index.source,level,ffmpeg,ffprobe});
            const digest=await md5File(encoded.file),destination=assetPath(input,level);
            try{await bucket.upload(encoded.file,{destination,resumable:true,validation:'md5',metadata:{contentType:'video/mp4',cacheControl:'private,no-store'},preconditionOpts:{ifGenerationMatch:0}});}
            catch(error){if(Number(error.code)!==412)throw error;}
            const [metadata]=await bucket.file(destination).getMetadata();
            if(Number(metadata.size)!==encoded.bytes||metadata.md5Hash!==digest||metadata.contentType!=='video/mp4')throw Error('Rendition integrity mismatch');
            const {file,...clean}=encoded;
            await mutate(name,current=>{
                if(current.sourceGeneration!==target.generation)throw Error('Rendition source changed');
                const levels=[...current.levels.filter(v=>v.id!==level.id),{...clean,generation:String(metadata.generation)}].sort((a,b)=>a.width*a.height-b.width*b.height);
                return {...current,levels,status:levels.length===qualityLevels(current.source).length?'ready':'processing',updatedAt:new Date(now()).toISOString()};
            });
            await mutate(claimName,current=>({...current,status:'complete'}));
            return {status:'ready',quality:level.id};
        } catch(error) {
            await mutate(claimName,current=>({...current,status:'failed',expiresAt:0}));
            if(claim.attempts<MAX_ATTEMPTS)throw Error('Video rendition retry required');
            await mutate(name,current=>({...current,failed:[...new Set([...(current.failed||[]),level.id])]}));
            return {status:'failed',quality:level.id};
        } finally {if(directory)await rm(directory,{recursive:true,force:true});}
    }
    return async object=>{
        const target=eventTarget(object);
        if(!target)return {status:'ignored'};
        return target.kind==='source'?prepare(target):process(target);
    };
}
module.exports={eventTarget,createVideoProcessor,md5File};
