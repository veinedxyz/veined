"""V1.18 rebrand supplement only: immutable V1.16 package referenced by hash, never nested."""
import argparse, hashlib, json, re, zipfile
from pathlib import Path
from datetime import datetime, timezone

p = argparse.ArgumentParser()
p.add_argument('--evidence', required=True)
p.add_argument('--output', required=True)
a = p.parse_args()
root = Path.cwd().resolve()
evidence = Path(a.evidence).resolve()
output = Path(a.output).resolve()
if not evidence.is_relative_to(root) or not output.is_relative_to(root):
    raise RuntimeError('WORKSPACE_PATH_REQUIRED')
output.mkdir(parents=True, exist_ok=True)
manifest = json.loads((evidence/'final/source-checkpoint.json').read_text())
prior = json.loads((evidence/'preflight/source-before.json').read_text())
sha = lambda b: hashlib.sha256(b).hexdigest()
secrets = set()
for env in root.glob('.env*'):
    if not env.is_file() or env.name == '.env.example':
        continue
    for line in env.read_text(encoding='utf-8-sig').splitlines():
        m = re.match(r'\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$', line)
        if not m or not re.search(r'SECRET|TOKEN|PASSWORD|API_KEY|DATABASE_URL|MIGRATOR_URL|INDEXER_URL|MONITOR_URL|BACKUP_URL', m[1]):
            continue
        value = m[2].strip('"\'')
        if len(value) >= 8:
            secrets.add(value.encode())
        for password in re.findall(r'://[^:/@]+:([^@]{8,})@', value):
            secrets.add(password.encode())
for source in (root/'src').rglob('*.json'):
    # Publicly committed RPC access tokens still do not belong in new evidence.
    for token in re.findall(rb'https://[^\s"<>]*nodereal\.io/v1/([A-Za-z0-9_-]{16,})', source.read_bytes()):
        secrets.add(token)

def scan(path, raw):
    parts = path.split('/')
    if path.startswith('/') or '..' in parts or any(x in ('node_modules','.git','__pycache__','.next') for x in parts) or ('secrets' in parts and not path.startswith('evidence/secrets/')):
        raise RuntimeError('FORBIDDEN_ARCHIVE_PATH:'+path)
    leaf = Path(path).name
    if (leaf.startswith('.env') and leaf != '.env.example') or Path(path).suffix.lower() in ('.pem','.key','.dump','.sqlite','.zip','.har','.webm'):
        raise RuntimeError('SENSITIVE_ARCHIVE_PATH:'+path)
    if any(value in raw for value in secrets):
        raise RuntimeError('LOCAL_SECRET_VALUE_DETECTED:'+path)
    if re.search(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{50,}-----END', raw):
        raise RuntimeError('PRIVATE_KEY_BODY_DETECTED:'+path)

entries = {}
delta = {}
for path, expected in manifest['hashes'].items():
    raw = (root/path).read_bytes()
    if sha(raw) != expected:
        raise RuntimeError('SOURCE_DRIFT:'+path)
    if prior['hashes'].get(path) != expected:
        delta[path] = expected
        entries['source-delta/'+path] = raw
for file in evidence.rglob('*'):
    if not file.is_file():
        continue
    if file.is_symlink():
        raise RuntimeError('EVIDENCE_SYMLINK')
    rel = file.relative_to(evidence).as_posix()
    if '/playwright-artifacts/' in rel or '/original-source/' in rel or '/source-copy/' in rel or file.suffix.lower() in ('.zip','.har','.webm','.pyc') or '__pycache__' in file.parts:
        continue
    entries['evidence/'+rel] = file.read_bytes()
entries['V116_BASE_REFERENCE.json'] = (json.dumps({
    'rcId':'OTHERBRIDGE_RC_V1_16_20261015T133159055Z-16dfa3',
    'sourceCheckpoint':'11bea158a16dc3f0528c4b6a9c24950728e1f26a3a3be86c2ca3ba5cabd5fcb9',
    'auditPackageSha256':'1ca5636aa97c3bd35e7338a282ee7ec576c6a85c9527bde5ebd7c7bd33eb928e',
    'reviewPackageSha256':'d6bab37dadf8b7292e52624e054e342eb33211dab472660ae4bb0b30f11cf1d5',
    'supplementCheckpoint':manifest['checkpoint'],
    'sourceDelta':delta,
    'execution':'CLOSED',
    'purpose':'VEINED rebrand development supplement. V1.16 audit identity and V1.17 checkpoint remain historical. No external audit, legal approval or production release is claimed.'},indent=2)+'\n').encode()
for path, raw in entries.items():
    scan(path, raw)
hashes = {path:sha(raw) for path,raw in sorted(entries.items())}
inventory = (json.dumps({'schemaVersion':1,'checkpoint':manifest['checkpoint'],'hashes':hashes},indent=2)+'\n').encode()
name='VEINED_V1_18_REBRAND_DEVELOPMENT_REVIEW_BUNDLE.zip'
target=output/name
with zipfile.ZipFile(target,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=True) as z:
    for path,raw in sorted(entries.items()):
        z.writestr(path,raw)
    z.writestr('ENTRY_SHA256.json',inventory)
with zipfile.ZipFile(target) as z:
    names=z.namelist()
    if len(names)!=len(set(names)) or len(names)!=len(hashes)+1 or z.testzip() is not None:
        raise RuntimeError('ZIP_STRUCTURE_FAILED')
    for path,expected in hashes.items():
        raw=z.read(path)
        if sha(raw)!=expected:
            raise RuntimeError('ENTRY_HASH_MISMATCH:'+path)
        scan(path,raw)
report={'at':datetime.now(timezone.utc).isoformat(),'path':str(target),'bytes':target.stat().st_size,'sha256':sha(target.read_bytes()),'entries':len(hashes)+1,'entryInventorySha256':sha(inventory),'deltaSourceFiles':len(delta),'checkpoint':manifest['checkpoint'],'crcErrors':0,'duplicatePaths':0,'secretLeaks':0,'secretValuesCompared':len(secrets),'perEntryHashesVerified':True,'priorZipIncluded':False,'pass':True,'execution':'CLOSED'}
(output/'ZIP_VERIFICATION.json').write_text(json.dumps(report,indent=2)+'\n')
(output/(name+'.sha256')).write_text(report['sha256']+'  '+name+'\n')
print(json.dumps(report),flush=True)
