'use strict';
// Additive streaming media only. Original uploads and editorial records are never rewritten.
const {spawn}=require('node:child_process');
const {mkdir,readFile,stat}=require('node:fs/promises');
const {join}=require('node:path');
const HLS='application/vnd.apple.mpegurl';
const PIPELINE=1;
const QUALITY_ID=/^q(?:[1-9][0-9]{1,3})$/;
const positive=n=>Number.isFinite(n)&&n>0;

function sourceInfo(probe) {
    const video=probe.streams?.find(s=>s.codec_type==='video');
    if(!video)throw Error('No video track');
    const rotation=Number(video.side_data_list?.find(s=>s.rotation!==undefined)?.rotation || 0);
    let width=Number(video.width),height=Number(video.height);
    if(Math.abs(rotation)%180===90)[width,height]=[height,width];
    const rate=String(video.avg_frame_rate || video.r_frame_rate || '30/1').split('/').map(Number);
    const fps=rate[0]/(rate[1]||1),duration=Number(probe.format?.duration || video.duration);
    if(![width,height,fps,duration].every(positive)||width>8192||height>8192||duration>600)throw Error('Unsupported video dimensions or duration');
    if(['smpte2084','arib-std-b67'].includes(video.color_transfer))throw Error('HDR requires a reviewed SDR rendition');
    return {width,height,duration,fps:Math.min(fps,60),audio:probe.streams.some(s=>s.codec_type==='audio')};
}
function qualityLevels(source) {
    const short=Math.min(source.width,source.height);
    if(!positive(short)||short<144)return [];
    const sizes=[360,720,1080,2160].filter(n=>n<=short);
    if(short<2160&&!sizes.includes(short))sizes.push(short);
    return sizes.sort((a,b)=>a-b).map(size=>{
        const scale=size/short;
        const width=Math.floor(source.width*scale/2)*2,height=Math.floor(source.height*scale/2)*2;
        const bitrate=size<=360?800000:size<=720?2800000:size<=1080?6000000:18000000;
        return {id:'q'+size,width,height,bitrate};
    });
}
function ffmpegArgs(input,output,source,level) {
    const fps=source.fps,gop=Math.max(1,Math.round(fps*2));
    return ['-hide_banner','-loglevel','error','-nostdin','-y','-i',input,
        '-map','0:v:0',...(source.audio?['-map','0:a:0']:['-an']),
        '-map_metadata','-1','-vf',`scale=${level.width}:${level.height}:flags=lanczos,setsar=1`,
        '-c:v','libx264','-preset','veryfast','-crf','21','-profile:v','high','-pix_fmt','yuv420p',
        '-threads','2','-r',String(fps),'-fps_mode','cfr','-g',String(gop),'-keyint_min',String(gop),
        '-sc_threshold','0','-force_key_frames','expr:gte(t,n_forced*2)',
        '-maxrate',String(level.bitrate),'-bufsize',String(level.bitrate*2),
        ...(source.audio?['-c:a','aac','-b:a','128k','-ar','48000','-ac','2']:[]),
        '-f','hls','-hls_time','4','-hls_list_size','0','-hls_playlist_type','vod',
        '-hls_segment_type','fmp4','-hls_flags','single_file+independent_segments',
        '-hls_segment_filename',join(output,'video.mp4'),join(output,'index.m3u8')];
}
function run(binary,args,{timeout=480000,capture=false}={}) {
    return new Promise((resolve,reject)=>{
        const child=spawn(binary,args,{stdio:['ignore',capture?'pipe':'ignore','pipe']});
        let stdout='',expired=false;
        child.stdout?.on('data',data=>{stdout+=data;if(stdout.length>4*1024*1024)child.kill('SIGKILL');});
        // Consume stderr without logging signed input URLs or uploaded filenames.
        child.stderr.on('data',()=>{});
        const timer=setTimeout(()=>{expired=true;child.kill('SIGKILL');},timeout);
        child.on('error',()=>{clearTimeout(timer);reject(Error('Video tool unavailable'));});
        child.on('close',code=>{clearTimeout(timer);code===0?resolve(stdout):reject(Error(expired?'Video processing time limit':'Video tool failed'));});
    });
}
async function probeSource(input,ffprobe) {
    return JSON.parse(await run(ffprobe,['-v','error','-show_streams','-show_format','-of','json',input],{capture:true,timeout:45000}));
}
function inspectPlaylist(playlist,bytes) {
    if(typeof playlist!=='string'||playlist.length>256000||!playlist.startsWith('#EXTM3U\n')||!playlist.includes('#EXT-X-ENDLIST')||!playlist.includes('#EXT-X-INDEPENDENT-SEGMENTS'))throw Error('Invalid completed HLS playlist');
    let duration=0,segmentDuration=0,peak=0,segments=0;
    for(const line of playlist.trim().split('\n')) {
        if(line.startsWith('#EXTINF:')) {segmentDuration=Number(line.slice(8).split(',')[0]);if(!positive(segmentDuration))throw Error('Invalid segment duration');duration+=segmentDuration;}
        if(line.startsWith('#EXT-X-BYTERANGE:')) {
            const match=/^#EXT-X-BYTERANGE:(\d+)@(\d+)$/.exec(line);
            if(!match||!positive(segmentDuration)||Number(match[1])+Number(match[2])>bytes)throw Error('Invalid segment range');
            peak=Math.max(peak,Number(match[1])*8/segmentDuration);segments++;
        }
        if(line&&!line.startsWith('#')&&line!=='video.mp4')throw Error('Unexpected playlist resource');
        if(line.startsWith('#EXT-X-MAP:')&&!/^#EXT-X-MAP:URI="video.mp4",BYTERANGE="\d+@0"$/.test(line))throw Error('Unexpected init resource');
    }
    if(!segments||!positive(duration))throw Error('Empty stream');
    return {duration,segments,bandwidth:Math.ceil(peak*1.05),averageBandwidth:Math.ceil(bytes*8/duration)};
}
async function encodeLevel({input,directory,source,level,ffmpeg,ffprobe}) {
    await mkdir(directory,{recursive:true});
    await run(ffmpeg,ffmpegArgs(input,directory,source,level));
    const file=join(directory,'video.mp4'),bytes=(await stat(file)).size;
    const playlist=await readFile(join(directory,'index.m3u8'),'utf8');
    const metrics=inspectPlaylist(playlist,bytes);
    const probe=await probeSource(file,ffprobe),video=probe.streams.find(s=>s.codec_type==='video');
    if(video.width!==level.width||video.height!==level.height||Math.abs(metrics.duration-source.duration)>0.2||source.audio!==probe.streams.some(s=>s.codec_type==='audio'))throw Error('Rendition verification failed');
    const codecs=`avc1.6400${Number(video.level).toString(16).padStart(2,'0')}`+(source.audio?',mp4a.40.2':'');
    return {...level,...metrics,bytes,playlist,file,codecs,fps:source.fps};
}
function validRenditions(data,original) {
    if(!data||data.pipeline!==PIPELINE||data.mediaId!==original.id||String(data.sourceGeneration)!==String(original.generation)||data.sourceSize!==original.size||!Array.isArray(data.levels)||data.levels.length>8||![data.source?.width,data.source?.height].every(n=>Number.isInteger(n)&&n>0&&n<=8192))return null;
    const ids=new Set();
    const levels=data.levels.filter(v=>{
        if(!v||!QUALITY_ID.test(v.id)||ids.has(v.id)||![v.width,v.height,v.bytes,v.bandwidth,v.averageBandwidth,v.fps].every(positive)||v.fps>60||v.width>data.source.width||v.height>data.source.height||typeof v.generation!=='string'||!/^\d+$/.test(v.generation)||!/^[a-z0-9.,]+$/.test(v.codecs||''))return false;
        try {inspectPlaylist(v.playlist,v.bytes);} catch {return false;}
        ids.add(v.id);return true;
    });
    return levels.length?{...data,levels:levels.sort((a,b)=>a.width*a.height-b.width*b.height)}:null;
}
function manifestUrl(postId,mediaId,variant) {
    return `https://us-west1-tip-line-8c2d7.cloudfunctions.net/newsMedia?post=${postId}&media=${mediaId}&variant=${variant}`;
}
function masterPlaylist(postId,mediaId,data) {
    const rows=['#EXTM3U','#EXT-X-VERSION:7','#EXT-X-INDEPENDENT-SEGMENTS'];
    for(const v of data.levels) rows.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},AVERAGE-BANDWIDTH=${v.averageBandwidth},RESOLUTION=${v.width}x${v.height},FRAME-RATE=${v.fps.toFixed(3)},CODECS="${v.codecs}"`,manifestUrl(postId,mediaId,v.id));
    return rows.join('\n')+'\n';
}
function signedPlaylist(level,url) {
    inspectPlaylist(level.playlist,level.bytes);
    const parsed=new URL(url);
    if(parsed.protocol!=='https:'||parsed.hostname!=='storage.googleapis.com'||/[\r\n"]/.test(url))throw Error('Invalid signed media URL');
    return level.playlist.replaceAll('"video.mp4"',`"${url}"`).split('\n').map(line=>line==='video.mp4'?url:line).join('\n');
}
module.exports={HLS,PIPELINE,QUALITY_ID,sourceInfo,qualityLevels,ffmpegArgs,probeSource,encodeLevel,inspectPlaylist,validRenditions,manifestUrl,masterPlaylist,signedPlaylist};
