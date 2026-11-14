"""Offline exact-source audit packaging. No credentials or dependency directories are copied."""
import argparse, hashlib, json, os, re, zipfile
from pathlib import Path
from datetime import datetime, timezone

p = argparse.ArgumentParser()
p.add_argument('--evidence', required=True)
p.add_argument('--build', required=True)
p.add_argument('--output', required=True)
a = p.parse_args()
root = Path.cwd().resolve()
evidence = Path(a.evidence).resolve()
build = Path(a.build).resolve()
output = Path(a.output).resolve()
if not evidence.is_relative_to(root) or not output.is_relative_to(root) or not build.is_relative_to(root):
    raise RuntimeError('WORKSPACE_PATH_REQUIRED')
output.mkdir(parents=True, exist_ok=True)
sha = lambda data: hashlib.sha256(data).hexdigest()
manifest = json.loads((evidence/'final/source-checkpoint.json').read_text())
build_manifest = json.loads((evidence/'final/build-manifest.json').read_text())
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
        for pw in re.findall(r'://[^:/@]+:([^@]{8,})@', value):
            secrets.add(pw.encode())
known_names = {'.env.local','.env.data.local','.env.staging.local','.env.production','.env.production.local'}
def safe_path(path):
    parts = path.split('/')
    if path.startswith('/') or '..' in parts or any(x in ('node_modules','.git','secrets','__pycache__') for x in parts):
        raise RuntimeError('FORBIDDEN_ARCHIVE_PATH:'+path)
    if Path(path).name in known_names or Path(path).suffix.lower() in ('.pem','.key','.dump','.sqlite','.zip'):
        raise RuntimeError('SECRET_OR_NESTED_ARCHIVE_PATH:'+path)
def scan(path, data):
    safe_path(path)
    if any(s in data for s in secrets):
        raise RuntimeError('LOCAL_SECRET_VALUE_DETECTED:'+path)
    if re.search(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{50,}-----END', data):
        raise RuntimeError('PRIVATE_KEY_BODY_DETECTED:'+path)

reports = []
for kind, name in [('audit','OTHERBRIDGE_V1_16_EXTERNAL_AUDIT_PACKAGE.zip'),('review','OTHERBRIDGE_V1_16_RELEASE_CANDIDATE_REVIEW_BUNDLE.zip')]:
    target = output/name
    if target.exists():
        raise RuntimeError('EXISTING_ARCHIVE_REFUSED:'+name)
    entries = {}
    for path, expected in manifest['hashes'].items():
        raw = (root/path).read_bytes()
        if sha(raw) != expected:
            raise RuntimeError('SOURCE_DRIFT:'+path)
        entries['source/'+path] = raw
    for path, expected in build_manifest['hashes'].items():
        raw = (build/path).read_bytes()
        if sha(raw) != expected:
            raise RuntimeError('BUILD_DRIFT:'+path)
        entries['production-build/'+path] = raw
    for file in evidence.rglob('*'):
        if not file.is_file() or file.is_symlink():
            continue
        rel = file.relative_to(evidence).as_posix()
        # Preserve prior failure receipts; large obsolete screenshots/source snapshots are review-only.
        if rel.startswith('preflight/source-snapshot/') or '/source-copy/' in rel:
            continue
        if kind == 'audit' and file.suffix.lower() in ('.png','.webm') and ('iteration1/' in rel or 'build-iteration1/' in rel):
            continue
        if file.suffix.lower() in ('.zip','.sqlite','.dump','.pem','.key') or any(x in ('node_modules','secrets') for x in file.parts):
            continue
        entries['evidence/'+rel] = file.read_bytes()
    # Source schema and output identities are separate; neither is an activation receipt.
    for path in ['release/candidate.json','release/FINAL_GATE_STATUS.json']:
        if (root/path).exists():
            entries['release-status/'+path.split('/')[-1]] = (root/path).read_bytes()
    if kind == 'review':
        # Bind the already verified audit input without nesting an earlier ZIP.
        entries['audit-package/verification.json'] = (json.dumps(reports[0],indent=2)+'\n').encode()
    for path, raw in entries.items():
        scan(path, raw)
    entry_hashes = {p:sha(b) for p,b in sorted(entries.items())}
    inventory = (json.dumps({'schemaVersion':1,'sourceCheckpoint':manifest['checkpoint'],'buildHash':build_manifest['checkpoint'],'hashes':entry_hashes},indent=2)+'\n').encode()
    with zipfile.ZipFile(target,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=True) as z:
        for path,raw in sorted(entries.items()):
            z.writestr(path,raw)
        z.writestr('ENTRY_SHA256.json',inventory)
    with zipfile.ZipFile(target) as z:
        names = z.namelist()
        if len(names)!=len(set(names)) or len(names)!=len(entry_hashes)+1 or z.testzip() is not None:
            raise RuntimeError('ZIP_STRUCTURE_FAILED')
        for path,expected in entry_hashes.items():
            raw=z.read(path)
            if sha(raw)!=expected:
                raise RuntimeError('ZIP_HASH_MISMATCH:'+path)
            scan(path,raw)
        actual_source={p.removeprefix('source/'):h for p,h in entry_hashes.items() if p.startswith('source/')}
        if actual_source!=manifest['hashes']:
            raise RuntimeError('ZIP_SOURCE_SET_MISMATCH')
    digest=sha(target.read_bytes())
    report={'at':datetime.now(timezone.utc).isoformat(),'kind':kind,'path':str(target),'bytes':target.stat().st_size,'sha256':digest,'entries':len(entry_hashes)+1,'entryInventorySha256':sha(inventory),'sourceFiles':len(actual_source),'sourceCheckpoint':manifest['checkpoint'],'buildHash':build_manifest['checkpoint'],'sourceExact':True,'hashesVerified':True,'crcErrors':0,'duplicateEntries':0,'secretLeaks':0,'secretValuesCompared':len(secrets),'secretScanScope':'All packaged bytes compared with actual local secret env values and DB password fragments; literal private-key bodies and forbidden paths; synthetic tests are not exempt from exact-secret matching','pass':True,'execution':'CLOSED'}
    (output/(name+'.sha256')).write_text(digest+'  '+name+'\n')
    (output/(name+'.verification.json')).write_text(json.dumps(report,indent=2)+'\n')
    reports.append(report)
    print(json.dumps({k:report[k] for k in ['kind','bytes','sha256','entries','sourceExact','pass']}),flush=True)
(output/'ZIP_VERIFICATION.json').write_text(json.dumps(reports,indent=2)+'\n')
