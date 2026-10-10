import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw, ImageFont

from banner_thumbnail import banner_thumbnail, MAX_JPEG_BYTES, _crop, _native_report, ThumbnailSkip


REPORT={'format':'tipline-local-report-v1','width':720,'height':1280,'fps':24,'total_frames':72,
        'graphics':[{'kind':'banner','start':0,'end':3,'x':90,'y':400,'width':540,'height':160,
                     'text':'TEST ONLY: ACTUAL FINISHED VIDEO'}]}
JOB={'id':'a'*20,'state':'ready','revision':1,'context_version':3,'plan_context_version':3}


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'),'Requires FFmpeg and FFprobe')
class BannerThumbnailTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture=tempfile.TemporaryDirectory();root=Path(cls.fixture.name).resolve()
        cls.video=root/'finished.mp4';image=Image.new('RGB',(720,1280),(15,25,35));draw=ImageDraw.Draw(image)
        draw.rectangle((90,400,629,559),fill=(10,55,135))
        font=ImageFont.truetype('/System/Library/Fonts/Avenir Next Condensed.ttc',32,index=0)
        draw.text((112,442),'TEST ONLY: ACTUAL FINISHED VIDEO',font=font,fill='white')
        # Four boundary markers establish that no part of the actual card is cut.
        for x,y in ((94,404),(616,404),(94,546),(616,546)):draw.rectangle((x,y,x+9,y+9),fill=(245,185,30))
        cls.source_image=root/'source.png';image.save(cls.source_image)
        subprocess.run([shutil.which('ffmpeg'),'-v','error','-nostdin','-loop','1','-framerate','24',
                        '-i',str(cls.source_image),'-t','3','-c:v','libx264','-crf','16','-pix_fmt','yuv420p',
                        '-y',str(cls.video)],check=True,capture_output=True)

    @classmethod
    def tearDownClass(cls):cls.fixture.cleanup()

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve()
        self.runtime=self.root/'runtime';self.state=self.root/'state'
        self.revision=self.runtime/'jobs'/JOB['id']/'r1';self.revision.mkdir(parents=True)
        self.video=self.revision/'review-draft.mp4';shutil.copy2(self.__class__.video,self.video)
        self.report=self.revision/'editable-report.json';self.report.write_text(json.dumps(REPORT))
        self.cfg={'runtime':str(self.runtime),'ffmpeg':shutil.which('ffmpeg'),'ffprobe':shutil.which('ffprobe')}

    def tearDown(self):self.temp.cleanup()

    def make(self,job=None):return banner_thumbnail(self.cfg,self.state,job or JOB)

    def test_actual_finished_video_crop_retains_banner_and_padding(self):
        result=self.make();self.assertTrue(result['ok'],result)
        self.assertEqual(result['crop'],{'x':58,'y':368,'width':604,'height':224})
        self.assertEqual((result['width'],result['height']),(604,224))
        self.assertLessEqual(result['bytes'],MAX_JPEG_BYTES)
        self.assertEqual(result['sample_frame'],35)
        self.assertTrue(Path(result['path']).is_relative_to(self.state/'thumbnails'))
        self.assertEqual(Path(result['path']).stat().st_mode&0o777,0o600)
        with Image.open(result['path']) as cropped:
            for x,y in ((99,409),(621,409),(99,551),(621,551)):
                r,g,b=cropped.getpixel((x-58,y-368))
                self.assertGreater(r,180);self.assertGreater(g,120);self.assertLess(b,90)
            # Outer padding still comes from the actual rendered picture.
            self.assertLess(max(cropped.getpixel((4,4))),50)

    def test_current_approved_report_is_also_eligible(self):
        job={**JOB,'state':'approved'}
        self.assertTrue(self.make(job)['ok'])

    def test_cache_reuses_image_without_running_ffmpeg_and_stat_change_invalidates_it(self):
        first=self.make();self.assertTrue(first['ok'],first)
        with patch('banner_thumbnail.subprocess.run') as command:
            second=self.make()
        command.assert_not_called();self.assertEqual(first,second)
        info=self.video.stat();os.utime(self.video,ns=(info.st_atime_ns,info.st_mtime_ns+1_000_000))
        third=self.make();self.assertTrue(third['ok'],third)
        self.assertNotEqual(first['cache_key'],third['cache_key'])

    def test_context_and_revision_invalidate_cached_thumbnail(self):
        first=self.make();current=self.make({**JOB,'context_version':4,'plan_context_version':4})
        self.assertTrue(current['ok'],current);self.assertNotEqual(first['cache_key'],current['cache_key'])
        next_revision=self.revision.parent/'r2';shutil.copytree(self.revision,next_revision)
        revised=self.make({**JOB,'revision':2})
        self.assertTrue(revised['ok'],revised);self.assertNotEqual(first['cache_key'],revised['cache_key'])

    def test_corrupt_cache_is_rebuilt_from_finished_video(self):
        first=self.make();Path(first['path']).write_bytes(b'corrupt')
        repaired=self.make();self.assertTrue(repaired['ok'],repaired)
        self.assertEqual(first['sha256'],repaired['sha256'])

    def test_old_report_needs_no_modern_glass_metadata(self):
        self.assertNotIn('graphics_style_version',REPORT)
        self.assertTrue(self.make()['ok'])

    def test_held_stale_and_invalid_id_never_read_or_render(self):
        cases=[({**JOB,'state':'held'},'job_not_ready'),({**JOB,'state':'queued'},'job_not_ready'),
               ({**JOB,'context_version':4},'stale_plan_context'),({**JOB,'id':'../../raw.mp4'},'invalid_job_id'),
               ({**JOB,'revision':True},'invalid_revision')]
        with patch('banner_thumbnail.subprocess.run') as command:
            for job,reason in cases:self.assertEqual(self.make(job),{'ok':False,'reason':reason})
        command.assert_not_called()

    def test_missing_report_and_missing_banner_skip_instead_of_using_raw_media(self):
        self.report.unlink()
        self.assertEqual(self.make()['reason'],'missing_editable_report')
        missing=copy.deepcopy(REPORT);missing['graphics']=[];self.report.write_text(json.dumps(missing))
        self.assertEqual(self.make()['reason'],'missing_banner_box')

    def test_source_symlink_and_parent_symlink_are_rejected(self):
        self.video.unlink();self.video.symlink_to(self.__class__.video)
        self.assertEqual(self.make()['reason'],'symlink_artifact_rejected')
        self.video.unlink();shutil.copy2(self.__class__.video,self.video)
        renamed=self.revision.parent/'original';self.revision.rename(renamed);self.revision.symlink_to(renamed,target_is_directory=True)
        self.assertEqual(self.make()['reason'],'symlink_artifact_rejected')

    def test_cache_symlink_is_rejected(self):
        self.state.mkdir();(self.state/'thumbnails').symlink_to(self.root/'elsewhere',target_is_directory=True)
        self.assertEqual(self.make()['reason'],'symlink_artifact_rejected')
        self.assertFalse((self.root/'elsewhere').exists())

    def test_dimensions_and_times_outside_actual_video_are_rejected(self):
        for mutation,reason in [({'x':700},'invalid_banner_box'),({'height':700},'invalid_banner_box'),
                                ({'end':12},'invalid_banner_timing'),({'end':.2},'banner_has_no_stable_hold')]:
            report=copy.deepcopy(REPORT);report['graphics'][0].update(mutation);self.report.write_text(json.dumps(report))
            self.assertEqual(self.make()['reason'],reason)
        report=copy.deepcopy(REPORT);report['width']=721;self.report.write_text(json.dumps(report))
        self.assertEqual(self.make()['reason'],'video_report_dimension_mismatch')

    def test_filename_shell_metacharacters_and_untrusted_banner_text_stay_literal(self):
        moved=self.root/'runtime $(touch BAD); literal';self.runtime.rename(moved);self.cfg['runtime']=str(moved)
        report=moved/'jobs'/JOB['id']/'r1/editable-report.json'
        payload=copy.deepcopy(REPORT);payload['graphics'][0]['text']='$(touch BAD) ; " : drawtext=file=/etc/passwd'
        report.write_text(json.dumps(payload));result=self.make()
        self.assertTrue(result['ok'],result);self.assertFalse((self.root/'BAD').exists())
        self.assertNotIn('text',result);self.assertNotIn('drawtext',json.dumps(result))

    def test_source_change_during_render_is_not_cached(self):
        actual=subprocess.run
        def mutate(args,**kwargs):
            result=actual(args,**kwargs)
            if args[0]==self.cfg['ffmpeg']:
                info=self.video.stat();os.utime(self.video,ns=(info.st_atime_ns,info.st_mtime_ns+1_000_000))
            return result
        with patch('banner_thumbnail.subprocess.run',side_effect=mutate):result=self.make()
        self.assertEqual(result['reason'],'source_changed_during_thumbnail')
        self.assertEqual(list((self.state/'thumbnails').glob('*.jpg')),[])


class CropGeometryTests(unittest.TestCase):
    def test_padding_clamps_to_frame_without_cutting_banner(self):
        report=copy.deepcopy(REPORT);report['graphics'][0].update(x=0,y=0)
        crop,_,_=_crop(report)
        self.assertEqual(crop,{'x':0,'y':0,'width':572,'height':192})

    def test_pinned_native_geometry_comes_only_from_verified_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();revision=Path('jobs')/JOB['id']/'r1';folder=root/revision;folder.mkdir(parents=True)
            archive=folder/'editable-timeline.drt';archive.write_bytes(b'known-native-archive-fixture')
            sha=hashlib.sha256(archive.read_bytes()).hexdigest()
            (folder/'technical-qc.json').write_text(json.dumps({'decode_ok':True,'width':1080,'height':1920,
                                                              'animation_guide':{'headline_seconds':[0,3]}}))
            (folder/'render-result.json').write_text(json.dumps({'rendered':True,'native_banner':True}))
            geometry={sha:(.206648446702002,.0510486192906688,769.5,300,72)}
            with patch('banner_thumbnail.VERIFIED_NATIVE_GEOMETRY',geometry):
                report,paths,identities=_native_report(root,revision)
                self.assertEqual(report['graphics'][0],{'kind':'banner','start':0,'end':3,'x':140,'y':750,'width':800,'height':223})
                self.assertEqual(len(paths),3);self.assertEqual(len(identities),3)
                self.assertFalse((folder/'editable-report.json').exists())
                archive.write_bytes(b'modified-native-archive')
                with self.assertRaisesRegex(ThumbnailSkip,'legacy_geometry_not_verified'):_native_report(root,revision)

    def test_native_qc_must_match_saved_opening_geometry(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();revision=Path('jobs')/JOB['id']/'r1';folder=root/revision;folder.mkdir(parents=True)
            archive=folder/'editable-timeline.drt';archive.write_bytes(b'known-native-archive-fixture')
            sha=hashlib.sha256(archive.read_bytes()).hexdigest()
            (folder/'technical-qc.json').write_text(json.dumps({'decode_ok':True,'width':1080,'height':1920,
                                                              'animation_guide':{'headline_seconds':[0,5]}}))
            (folder/'render-result.json').write_text(json.dumps({'rendered':True,'native_banner':True}))
            with patch('banner_thumbnail.VERIFIED_NATIVE_GEOMETRY',{sha:(.2,.05,769.5,300,72)}):
                with self.assertRaisesRegex(ThumbnailSkip,'native_geometry_evidence_mismatch'):_native_report(root,revision)


if __name__=='__main__':unittest.main()
