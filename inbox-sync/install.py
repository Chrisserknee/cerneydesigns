"""Install this companion without changing or restarting the report producer."""
import os, pathlib, plistlib, shutil, subprocess, sys
home=pathlib.Path.home();base=home/'Library/Application Support/Cerney Tips Inbox Sync'
base.mkdir(parents=True,exist_ok=True,mode=0o700);base.chmod(0o700)
for name in ('sync.py','publish.cjs'):
 shutil.copy2(pathlib.Path(__file__).with_name(name),base/name);(base/name).chmod(0o600)
config=home/'Library/Application Support/Chris Cerney Tipline Producer/config.json'
if not config.is_file():raise SystemExit('Existing producer configuration is required')
label='org.chriscerney.tip-inbox-sync';plist=home/'Library/LaunchAgents'/f'{label}.plist'
job={'Label':label,'ProgramArguments':[sys.executable,str(base/'sync.py'),'--config',str(config),'--state-dir',str(base/'state')],
 'WorkingDirectory':str(base),'RunAtLoad':True,'StartInterval':20,'ProcessType':'Background','Umask':63,
 'EnvironmentVariables':{'PYTHONDONTWRITEBYTECODE':'1','PATH':'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'},
 'StandardOutPath':str(base/'sync.log'),'StandardErrorPath':str(base/'sync-error.log')}
if plist.exists():subprocess.run(['launchctl','bootout',f'gui/{os.getuid()}',str(plist)],capture_output=True)
plist.write_bytes(plistlib.dumps(job));plist.chmod(0o600)
subprocess.run(['launchctl','bootstrap',f'gui/{os.getuid()}',str(plist)],check=True)
print('Installed private inbox companion; report producer left running unchanged.')
