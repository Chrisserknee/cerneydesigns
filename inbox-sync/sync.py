"""Read-only bridge from existing Claude report artifacts to the private inbox."""
import argparse, datetime, fcntl, hashlib, json, os, re, sqlite3, subprocess
from pathlib import Path

SOURCE=re.compile(r'^tips/(?:submit-story_)?\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-z0-9]{12}/_submission\.json$')

def clean(value,limit):
    return re.sub(r'\s+',' ',value).strip()[:limit] if isinstance(value,str) else ''

def read_json(path, root):
    if not path.exists():return {}
    if not path.resolve().is_relative_to(root.resolve()) or path.is_symlink() or path.stat().st_size>256000:raise ValueError('Unsafe artifact')
    value=json.loads(path.read_text())
    return value if isinstance(value,dict) else {}

def describe(job,plan,context):
    source=job['source']
    if not SOURCE.fullmatch(source) or not re.fullmatch('[a-f0-9]{20}',job['id']):return None
    current=job['plan_context_version']>=job['context_version']
    title=clean(plan.get('story_title') or plan.get('headline'),100) if current and plan.get('decision')=='draft' else ''
    summary=clean(plan.get('instagram_description','').split('\n\n')[0],420) if title else ''
    return dict(version=1,id=hashlib.sha256(source.encode()).hexdigest(),source=source,
        sourceGeneration=str(job['generation']),sourceContextAt=context.get('receivedAt',''),
        state=job['state'],revision=job['revision'],contextVersion=job['context_version'],
        title=title,summary=summary,contextSource='claude' if title else 'pending',updatedAt=job['updated'])

def run(config_path,state_dir):
    cfg=json.loads(config_path.read_text());runtime=Path(cfg['runtime']);state_dir.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (state_dir/'sync.lock').open('w') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return
        db=sqlite3.connect((runtime/'queue.sqlite3').as_uri()+'?mode=ro',uri=True,timeout=3);db.row_factory=sqlite3.Row
        cutoff=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=30)).isoformat().replace('+00:00','Z')
        jobs=db.execute('SELECT j.id,j.source,j.generation,j.state,j.revision,j.updated,j.context_version,j.plan_context_version,c.payload FROM jobs j LEFT JOIN tip_contexts c ON c.job_id=j.id WHERE j.created>=? ORDER BY j.updated',(cutoff,)).fetchall();db.close()
        latest={}
        for row in jobs:
            key=row['source']
            if not SOURCE.fullmatch(key) or not str(row['generation']).isdigit():continue
            if key not in latest or int(row['generation'])>int(latest[key]['generation']):latest[key]=row
        jobs=list(latest.values())
        receipt_path=state_dir/'receipts.json';receipts=read_json(receipt_path,state_dir);changed=[];digests={};skipped=0
        for row in jobs:
            job=dict(row)
            if not SOURCE.fullmatch(job['source']) or not re.fullmatch('[a-f0-9]{20}',job['id']):continue
            try:
                plan=read_json(runtime/'jobs'/job['id']/f'r{int(job["revision"])}'/'edit-plan.json',runtime)
                context=json.loads(job['payload']) if job['payload'] else {}
                item=describe(job,plan,context)
                digest=hashlib.sha256(json.dumps(item,sort_keys=True).encode()).hexdigest();digests[item['id']]=digest
                if receipts.get(item['id'])!=digest:changed.append(item)
            except (ValueError,OSError,TypeError):skipped+=1
        if changed:
            # Batched, private storage writes only. No AI requests, notifications,
            # queue changes, renderer restarts, or original-media modifications.
            proc=subprocess.run([cfg['node'],str(Path(__file__).with_name('publish.cjs'))],input=json.dumps({'config':str(config_path),'items':changed[:25]}),text=True,capture_output=True,timeout=180)
            if proc.returncode:raise RuntimeError('Inbox publish failed; will retry')
            result=json.loads(proc.stdout)
            for id in result['saved']:receipts[id]=digests[id]
            tmp=state_dir/'receipts.tmp';tmp.write_text(json.dumps(receipts));tmp.chmod(0o600);tmp.replace(receipt_path)
        else:result={'saved':[]}
        status={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'jobsChecked':len(jobs),'updated':len(result['saved']),'skipped':skipped}
        (state_dir/'health.json').write_text(json.dumps(status));print(json.dumps(status))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--config',type=Path,required=True);parser.add_argument('--state-dir',type=Path,required=True);args=parser.parse_args()
    try:run(args.config,args.state_dir)
    except Exception as error:
        # Keep source content, credentials and private provider responses out of logs.
        print(json.dumps({'error':type(error).__name__,'retry':'next scheduled run'}));raise SystemExit(1)
