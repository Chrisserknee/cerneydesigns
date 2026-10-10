"""Small, private crops of delivered reports; never a raw-media/title-card fallback.

The bridge must verify the current Drive delivery receipt before calling this
helper. It additionally checks ready/approved state and current plan context.
Only the finished revision's actual video and saved graphic geometry are read.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile


THUMBNAIL_VERSION = 'headline-crop-v1'
PADDING = 32
MAX_WIDTH = 800
MAX_HEIGHT = 900
MAX_JPEG_BYTES = 150 * 1024
MAX_VIDEO_BYTES = 2_000_000_000
MAX_REPORT_BYTES = 256 * 1024
JOB_ID = re.compile(r'[a-f0-9]{20}\Z')
# Frozen, individually inspected Resolve archives from the pre-local renderer.
# Values are the saved Rectangle1.Width, AnimCurves1.Scale (half-height),
# persisted clip Tilt, total frames and opening frames, respectively. SHA-256
# pins the entire .drt, including its native geometry and animation graph.
# An unknown/modified archive is deliberately unsupported: never estimate its
# box from a headline string, the current font/template, or image detection.
VERIFIED_NATIVE_GEOMETRY = {
    '496b3456e1c5869716c21af537248719f210d28bc02be001bf41f1a0f5aeb15f':(.206648446702002,.0510486192906688,769.5,300,72),
    '7f405eb29ea467b5a99eda3c99bd28224553f5c48f170153cb2af148fb22c01f':(.206388030035336,.0496597304017799,769.5,600,120),
    '98e1665db15d93fc9a802442358d20deb6b596cdf1bd6034cf2b22b3aafa8162':(.206648446702002,.0568356563277058,1089.5,197,120),
    'bcb3ef780ed9577b47e4ff6ea6596fa1673b4ca5202629b8c21bd7e958080deb':(.206648446702002,.0471134341054836,1089.5,329,72),
    '5fdcc3c7716409b6fa108694ca618e48f71fedc1fc4a159058062090a1fb3fcf':(.206648446702002,.0461875081795576,1089.5,672,72),
    '674e86c1cd7cb91679007827bb43451e2301e5dbad44ae16a8701c169244b6cf':(.206648446702002,.0454930637351132,1089.5,240,120),
    '66428e647840b63ef8b6b0b34f5c627d5131900aa4c83070a10067e31d27994c':(.206648446702002,.0475763970684465,769.5,216,120),
}


class ThumbnailSkip(ValueError):
    pass


def _number(value, minimum, maximum, reason, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ThumbnailSkip(reason)
    if not minimum <= value <= maximum or (integer and int(value) != value):
        raise ThumbnailSkip(reason)
    return int(value) if integer else float(value)


def _root(path, create=False):
    path=Path(path)
    if not path.is_absolute() or '..' in path.parts or any(p.is_symlink() for p in (path,*path.parents)):
        raise ThumbnailSkip('unsafe_root_path')
    if create:path.mkdir(parents=True,exist_ok=True,mode=0o700)
    if not path.is_dir():raise ThumbnailSkip('missing_runtime_or_state_directory')
    return path.resolve(strict=True)


def _safe_path(root, relative, *, missing=None, maximum=None):
    path=root/relative
    if not path.is_relative_to(root):raise ThumbnailSkip('unsafe_artifact_path')
    cursor=root
    for part in path.relative_to(root).parts:
        if part in ('.','..'):raise ThumbnailSkip('unsafe_artifact_path')
        cursor=cursor/part
        if cursor.is_symlink():raise ThumbnailSkip('symlink_artifact_rejected')
    if not path.resolve().is_relative_to(root):raise ThumbnailSkip('unsafe_artifact_path')
    if not path.exists():
        if missing:raise ThumbnailSkip(missing)
        return path
    info=path.stat()
    if not stat.S_ISREG(info.st_mode):raise ThumbnailSkip('artifact_is_not_regular_file')
    if maximum is not None and not 0 < info.st_size <= maximum:raise ThumbnailSkip('artifact_size_out_of_bounds')
    return path


def _identity(path):
    info=path.stat()
    return {'size':info.st_size,'mtime_ns':info.st_mtime_ns,'ctime_ns':info.st_ctime_ns,
            'device':info.st_dev,'inode':info.st_ino}


def _identities(paths):
    return [_identity(path) for path in paths]


def _json(path):
    try:
        value=json.loads(path.read_text(),parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (UnicodeError,ValueError):raise ThumbnailSkip('invalid_artifact_json')
    if not isinstance(value,dict):raise ThumbnailSkip('invalid_artifact_json')
    return value


def _run(args, timeout=45):
    try:
        result=subprocess.run([str(x) for x in args],capture_output=True,timeout=timeout,check=False)
    except subprocess.TimeoutExpired:raise ThumbnailSkip('thumbnail_command_timed_out')
    if result.returncode:raise ThumbnailSkip('thumbnail_command_failed')
    return result.stdout


def _jpeg_dimensions(data):
    """Read JPEG dimensions without adding a Pillow dependency to the bridge."""
    if len(data)<4 or data[:2]!=b'\xff\xd8' or data[-2:]!=b'\xff\xd9':raise ThumbnailSkip('invalid_thumbnail_jpeg')
    offset=2
    while offset<len(data)-2:
        if data[offset]!=255:raise ThumbnailSkip('invalid_thumbnail_jpeg')
        while offset<len(data) and data[offset]==255:offset+=1
        if offset>=len(data):break
        marker=data[offset];offset+=1
        if marker in (0x01,0xd8) or 0xd0<=marker<=0xd7:continue
        if marker in (0xd9,0xda):break
        if offset+2>len(data):break
        length=int.from_bytes(data[offset:offset+2],'big')
        if length<2 or offset+length>len(data):break
        if marker in (0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf):
            if length<8:break
            height=int.from_bytes(data[offset+3:offset+5],'big')
            width=int.from_bytes(data[offset+5:offset+7],'big')
            if not (1<=width<=MAX_WIDTH and 1<=height<=MAX_HEIGHT):raise ThumbnailSkip('thumbnail_dimensions_out_of_bounds')
            return width,height
        offset+=length
    raise ThumbnailSkip('invalid_thumbnail_jpeg')


def _crop(report):
    width=_number(report.get('width'),80,8192,'invalid_report_dimensions',True)
    height=_number(report.get('height'),80,8192,'invalid_report_dimensions',True)
    fps=_number(report.get('fps'),1,120,'invalid_report_timing')
    frames=_number(report.get('total_frames'),1,216000,'invalid_report_timing',True)
    if frames/fps>1800:raise ThumbnailSkip('invalid_report_timing')
    graphics=report.get('graphics')
    if not isinstance(graphics,list):raise ThumbnailSkip('missing_banner_box')
    banner=next((g for g in graphics if isinstance(g,dict) and g.get('kind')=='banner'),None)
    if not banner:raise ThumbnailSkip('missing_banner_box')
    x=_number(banner.get('x'),0,width,'invalid_banner_box',True)
    y=_number(banner.get('y'),0,height,'invalid_banner_box',True)
    w=_number(banner.get('width'),40,width,'invalid_banner_box',True)
    h=_number(banner.get('height'),20,min(600,height/2),'invalid_banner_box',True)
    if x+w>width or y+h>height:raise ThumbnailSkip('invalid_banner_box')
    start=_number(banner.get('start'),0,frames/fps,'invalid_banner_timing')
    end=_number(banner.get('end'),0,frames/fps,'invalid_banner_timing')
    # Existing and modern reports both use seven-frame banner fades. Keep a
    # complete frame of margin on either side and sample the center of the hold.
    first=math.ceil(start*fps)+8;last=math.floor(end*fps)-9
    if last<first:raise ThumbnailSkip('banner_has_no_stable_hold')
    frame=(first+last)//2
    if not 0<=frame<frames:raise ThumbnailSkip('invalid_banner_timing')
    left=max(0,x-PADDING);top=max(0,y-PADDING)
    right=min(width,x+w+PADDING);bottom=min(height,y+h+PADDING)
    crop={'x':left,'y':top,'width':right-left,'height':bottom-top}
    if crop['height']>MAX_HEIGHT:raise ThumbnailSkip('thumbnail_dimensions_out_of_bounds')
    return crop,frame,{'width':width,'height':height,'fps':fps,'total_frames':frames}


def _native_report(runtime, revision_dir):
    archive=_safe_path(runtime,revision_dir/'editable-timeline.drt',
                       missing='missing_editable_report',maximum=2*1024*1024)
    qc_path=_safe_path(runtime,revision_dir/'technical-qc.json',missing='missing_native_qc',maximum=MAX_REPORT_BYTES)
    result_path=_safe_path(runtime,revision_dir/'render-result.json',missing='missing_native_render_receipt',maximum=16384)
    paths=[archive,qc_path,result_path];identities=_identities(paths)
    geometry=VERIFIED_NATIVE_GEOMETRY.get(hashlib.sha256(archive.read_bytes()).hexdigest())
    if geometry is None:raise ThumbnailSkip('legacy_geometry_not_verified')
    mask_width,half_height,tilt,frames,opening=geometry
    qc=_json(qc_path);result=_json(result_path)
    if (result.get('rendered') is not True or result.get('native_banner') is not True
            or qc.get('decode_ok') is not True or (qc.get('width'),qc.get('height'))!=(1080,1920)
            or qc.get('animation_guide',{}).get('headline_seconds')!=[0,opening/24]):
        raise ThumbnailSkip('native_geometry_evidence_mismatch')
    # These pinned compositions use a 1920x1080 canvas, ContentXF.Size=1.132,
    # ContentXF.Center=(.5,.138), and the held rectangle center Y=.46+half_height.
    # Resolve fills the vertical output by canvas height, then applies saved Tilt.
    # Round outward; the normal extra 32px padding also preserves the native rim.
    w=mask_width*1920*(16/9)*1.132;h=2*half_height*1920*1.132
    center_from_bottom=(.138+(.46+half_height-.5)*1.132)*1920+tilt
    x=math.floor((1080-w)/2);right=math.ceil((1080+w)/2)
    y=math.floor(1920-center_from_bottom-h/2);bottom=math.ceil(1920-center_from_bottom+h/2)
    report={'width':1080,'height':1920,'fps':24,'total_frames':frames,
            'graphics':[{'kind':'banner','start':0,'end':opening/24,'x':x,'y':y,'width':right-x,'height':bottom-y}]}
    return report,paths,identities


def _probe(cfg, video, expected):
    try:
        value=json.loads(_run([cfg['ffprobe'],'-v','error','-protocol_whitelist','file,pipe',
                               '-select_streams','v:0','-show_streams','-of','json',video]))
        stream=value['streams'][0]
        width=int(stream['width']);height=int(stream['height'])
        duration=float(stream['duration'])
        numerator,denominator=str(stream['avg_frame_rate']).split('/')
        fps=float(numerator)/float(denominator)
        count=stream.get('nb_frames')
    except (KeyError,IndexError,TypeError,ValueError,ZeroDivisionError):raise ThumbnailSkip('invalid_finished_video_metadata')
    if (width,height)!=(expected['width'],expected['height']):raise ThumbnailSkip('video_report_dimension_mismatch')
    if not math.isfinite(fps) or abs(fps-expected['fps'])>.01:raise ThumbnailSkip('video_report_timing_mismatch')
    if not math.isfinite(duration) or abs(duration-expected['total_frames']/expected['fps'])>1.1/expected['fps']:
        raise ThumbnailSkip('video_report_timing_mismatch')
    if count is not None and str(count).isdigit() and int(count)!=expected['total_frames']:
        raise ThumbnailSkip('video_report_timing_mismatch')


def _write_json(path,value):
    fd,name=tempfile.mkstemp(dir=path.parent,prefix='.thumbnail-',suffix='.json')
    try:
        with os.fdopen(fd,'w') as out:
            json.dump(value,out,sort_keys=True,allow_nan=False);out.flush();os.fsync(out.fileno())
        os.replace(name,path)
    finally:
        if os.path.exists(name):os.unlink(name)


def banner_thumbnail(cfg, state_dir, job):
    """Return `{ok, path, sha256, width, height, bytes, ...}` or a skip reason.

    `job` is the current trusted queue row. The caller must first verify its
    delivered receipt; this helper performs no delivery, publishing or AI work.
    """
    try:
        if job.get('state') not in ('ready','approved'):raise ThumbnailSkip('job_not_ready')
        id=job.get('id')
        if not isinstance(id,str) or not JOB_ID.fullmatch(id):raise ThumbnailSkip('invalid_job_id')
        revision=_number(job.get('revision'),1,1_000_000,'invalid_revision',True)
        context=_number(job.get('context_version'),0,1_000_000_000,'invalid_context_version',True)
        plan_context=_number(job.get('plan_context_version'),0,1_000_000_000,'invalid_context_version',True)
        if plan_context<context:raise ThumbnailSkip('stale_plan_context')
        runtime=_root(cfg['runtime'])
        revision_dir=Path('jobs')/id/f'r{revision}'
        video=_safe_path(runtime,revision_dir/'review-draft.mp4',missing='missing_finished_video',maximum=MAX_VIDEO_BYTES)
        source_identity=_identity(video)
        report_path=_safe_path(runtime,revision_dir/'editable-report.json',maximum=MAX_REPORT_BYTES)
        if report_path.is_file():
            report_paths=[report_path];report_identity=_identities(report_paths);report=_json(report_path)
            geometry_source='editable_report'
        else:
            report,report_paths,report_identity=_native_report(runtime,revision_dir)
            geometry_source='verified_native_archive_v1'
        crop,frame,expected=_crop(report)
        key_data={'version':THUMBNAIL_VERSION,'job_id':id,'revision':revision,'context_version':context,
                  'plan_context_version':plan_context,'source':source_identity,'report':report_identity,
                  'crop':crop,'frame':frame,'max_width':MAX_WIDTH,'padding':PADDING,'geometry_source':geometry_source}
        cache_key=hashlib.sha256(json.dumps(key_data,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        state=_root(state_dir,create=True)
        directory=state/'thumbnails'
        if directory.is_symlink():raise ThumbnailSkip('symlink_artifact_rejected')
        directory.mkdir(mode=0o700,exist_ok=True)
        name=f'{id}-r{revision}-c{context}-{cache_key[:32]}'
        target=_safe_path(state,Path('thumbnails')/(name+'.jpg'),maximum=MAX_JPEG_BYTES)
        manifest_path=_safe_path(state,Path('thumbnails')/(name+'.json'),maximum=16384)
        base_result={'ok':True,'version':THUMBNAIL_VERSION,'path':str(target),'mime_type':'image/jpeg',
                     'cache_key':cache_key,'revision':revision,'context_version':context,'job_id':id,
                     'crop':crop,'sample_frame':frame,'sample_time':round(frame/expected['fps'],6),
                     'geometry_source':geometry_source}
        if target.is_file() and manifest_path.is_file():
            try:
                cached=_json(manifest_path);data=target.read_bytes();dimensions=_jpeg_dimensions(data)
                digest=hashlib.sha256(data).hexdigest()
                valid=(cached.get('cache_key')==cache_key and cached.get('sha256')==digest
                       and (cached.get('width'),cached.get('height'))==dimensions and cached.get('bytes')==len(data))
            except ThumbnailSkip:
                valid=False  # Rebuild an incomplete/corrupt cache; never change the source.
            if valid:
                if _identity(video)!=source_identity or _identities(report_paths)!=report_identity:
                    raise ThumbnailSkip('source_changed_during_thumbnail')
                return dict(base_result,sha256=digest,width=dimensions[0],height=dimensions[1],bytes=len(data))
        _probe(cfg,video,expected)
        fd,name=tempfile.mkstemp(dir=directory,prefix='.thumbnail-',suffix='.jpg');os.close(fd)
        temporary=Path(name)
        try:
            for quality in (4,8,14,22,31):
                graph=(f'select=eq(n\\,{frame}),format=rgb24,crop={crop["width"]}:{crop["height"]}:{crop["x"]}:{crop["y"]},'
                       f'scale=min({MAX_WIDTH}\\,iw):-2')
                _run([cfg['ffmpeg'],'-hide_banner','-loglevel','error','-nostdin','-protocol_whitelist','file,pipe',
                      '-i',video,'-map','0:v:0','-vf',graph,'-frames:v','1','-an','-sn','-dn',
                      '-map_metadata','-1','-map_chapters','-1','-q:v',str(quality),'-y',temporary])
                if 0<temporary.stat().st_size<=MAX_JPEG_BYTES:break
            else:raise ThumbnailSkip('thumbnail_size_limit_exceeded')
            data=temporary.read_bytes();width,height=_jpeg_dimensions(data)
            if _identity(video)!=source_identity or _identities(report_paths)!=report_identity:
                raise ThumbnailSkip('source_changed_during_thumbnail')
            result=dict(base_result,sha256=hashlib.sha256(data).hexdigest(),width=width,height=height,bytes=len(data))
            os.replace(temporary,target)
            _write_json(manifest_path,{k:v for k,v in result.items() if k not in ('ok','path')})
            return result
        finally:
            temporary.unlink(missing_ok=True)
    except ThumbnailSkip as error:
        return {'ok':False,'reason':str(error)}
    except (OSError,KeyError,TypeError,ValueError,OverflowError):
        return {'ok':False,'reason':'thumbnail_io_or_configuration_error'}
