import datetime
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import types
import unittest
from unittest.mock import patch
import sync


class SyncThumbnailTests(unittest.TestCase):
    def test_only_current_delivered_reports_request_a_preview_and_publish_versioned_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();runtime=root/'runtime';runtime.mkdir();state=root/'state'
            cfg={'runtime':str(runtime),'node':'unused-node'};config=root/'config.json';config.write_text(json.dumps(cfg))
            db=sqlite3.connect(runtime/'queue.sqlite3')
            db.executescript('CREATE TABLE jobs(id TEXT,source TEXT,generation TEXT,state TEXT,revision INTEGER,updated TEXT,created TEXT,context_version INTEGER,plan_context_version INTEGER);CREATE TABLE tip_contexts(job_id TEXT,payload TEXT);')
            now=datetime.datetime.now(datetime.timezone.utc).isoformat();ids=[]
            for number,(status,current,verified) in enumerate((('ready',True,True),('ready',True,False),('held',True,True),('ready',False,True))):
                source=f'tips/2026-10-10_12-00-00_abcdefghijk{number}/_submission.json';jid=hashlib.sha256(source.encode()).hexdigest()[:20];ids.append(jid)
                db.execute('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)',(jid,source,'123',status,2,now,now,2,2 if current else 1))
                db.execute('INSERT INTO tip_contexts VALUES (?,?)',(jid,json.dumps({'receivedAt':now})))
                folder=runtime/'jobs'/jid/'r2';folder.mkdir(parents=True)
                (folder/'edit-plan.json').write_text(json.dumps({'decision':'draft','headline':'SYNTHETIC TEST','instagram_description':'Test only.'}))
                (folder/'drive-upload-receipt.json').write_text(json.dumps({'verified':verified,'source':source,'generation':'123','revision':2}))
            db.commit();db.close();published=[]
            preview={'ok':True,'sha256':'a'*64,'width':800,'height':300,'bytes':40000,'path':str(state/'thumbnails/test.jpg')}
            def publish(_args,**kwargs):
                payload=json.loads(kwargs['input']);published.append(payload)
                return types.SimpleNamespace(returncode=0,stdout=json.dumps({'saved':[i['id'] for i in payload['items']]}))
            with patch.object(sync,'banner_thumbnail',return_value=preview) as make,patch.object(sync.subprocess,'run',side_effect=publish):
                sync.run(config,state)
                self.assertEqual(make.call_count,1)
                self.assertEqual(make.call_args.args[2]['id'],ids[0])
                items=published[0]['items'];self.assertEqual(len(items),4)
                ready=next(i for i in items if i['draftJobId']==ids[0])
                self.assertEqual(ready['thumbnail']['revision'],2)
                self.assertEqual(ready['thumbnail']['contextVersion'],2)
                self.assertEqual(ready['planContextVersion'],2)
                self.assertEqual(ready['thumbnail']['jobId'],ids[0])
                self.assertNotIn('path',ready['thumbnail'])
                self.assertEqual(published[0]['thumbnailFiles'],{ready['id']:preview['path']})
                self.assertTrue(all(i['thumbnail'] is None for i in items if i is not ready))
                sync.run(config,state)
                self.assertEqual(len(published),1,'Unchanged previews must not republish or retrigger storage events.')

    def test_delivery_receipt_must_match_generation_revision_and_current_context(self):
        job={'state':'ready','source':'tips/test/_submission.json','generation':'123','revision':2,'plan_context_version':1,'context_version':1}
        receipt={'verified':True,'source':job['source'],'generation':'123','revision':2}
        self.assertTrue(sync.delivered(job,receipt))
        self.assertTrue(sync.delivered({**job,'state':'approved'},receipt))
        for change in ({'verified':False},{'generation':'124'},{'revision':1},{'source':'other'}):
            self.assertFalse(sync.delivered(job,{**receipt,**change}))
        self.assertFalse(sync.delivered({**job,'context_version':2},receipt))


if __name__=='__main__':unittest.main()
