'use strict';
const {publicPost}=require('./news-core');
const {HLS,validRenditions,manifestUrl}=require('./news-video-core');
const recordPath=record=>`renditions/${record.id}/${record.generation}.json`;
const assetPath=(record,level)=>`_news/v1/streams/${record.id}/${record.generation}/v1/${level.id}.mp4`;
function createRenditionReader({read,now=Date.now}) {
    const cache=new Map();
    return async record=>{
        if(!record.type?.startsWith('video/')||!/^\d+$/.test(String(record.generation)))return null;
        const key=recordPath(record),known=cache.get(key);
        if(known&&known.expires>now())return known.value;
        let value=null;
        try {value=validRenditions((await read(key))?.data,record);} catch {return null;}
        if(cache.size>=128)cache.delete(cache.keys().next().value);
        cache.set(key,{value,expires:now()+15000});
        return value;
    };
}
function decorateVideoPost(readRenditions) {
    return async post=>{
        const result=publicPost(post);
        result.media=await Promise.all(result.media.map(async(item,i)=>{
            const data=await readRenditions(post.media[i]);
            if(!data)return item;
            return {...item,width:data.source.width,height:data.source.height,
                variants:[{id:'adaptive',type:HLS,url:manifestUrl(post.id,item.id,'adaptive')},
                    ...data.levels.map(level=>({id:level.id,type:HLS,url:manifestUrl(post.id,item.id,level.id),width:level.width,height:level.height,bitrate:level.averageBandwidth}))]};
        }));
        return result;
    };
}
module.exports={recordPath,assetPath,createRenditionReader,decorateVideoPost};
