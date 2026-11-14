"""Owner-review supplement. Archive only this run and the verified source delta."""
import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path
from datetime import datetime, timezone

parser = argparse.ArgumentParser()
parser.add_argument('--evidence', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
root = Path.cwd().resolve()
evidence = Path(args.evidence).resolve()
output = Path(args.output).resolve()
if not evidence.is_relative_to(root) or not output.is_relative_to(root):
    raise RuntimeError('WORKSPACE_PATH_REQUIRED')
output.mkdir(parents=True, exist_ok=True)
current = json.loads((evidence/'final/source-checkpoint.json').read_text(encoding='utf-8-sig'))
prior = json.loads((evidence/'preflight/source-before.json').read_text(encoding='utf-8-sig'))
sha = lambda raw: hashlib.sha256(raw).hexdigest()
secrets = set()
for env in root.glob('.env*'):
    if not env.is_file() or env.name == '.env.example':
        continue
    for line in env.read_text(encoding='utf-8-sig').splitlines():
        match = re.match(r'\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$', line)
        if not match or not re.search(r'SECRET|TOKEN|PASSWORD|API_KEY|DATABASE_URL|MIGRATOR_URL|INDEXER_URL|MONITOR_URL|BACKUP_URL', match[1]):
            continue
        value = match[2].strip('\"\'')
        if len(value) >= 8:
            secrets.add(value.encode())
        for password in re.findall(r'://[^:/@]+:([^@]{8,})@', value):
            secrets.add(password.encode())
for source in (root/'src').rglob('*.json'):
    secrets.update(re.findall(rb'https://[^\s\"<>]*nodereal\.io/v1/([A-Za-z0-9_-]{16,})', source.read_bytes()))

def scan(path, raw):
    parts = path.split('/')
    forbidden = {'.git', 'node_modules', '__pycache__', '.next', 'secrets', 'sessions', 'private-sessions'}
    if path.startswith('/') or '..' in parts or any(p in forbidden for p in parts):
        raise RuntimeError('FORBIDDEN_PATH:'+path)
    leaf = Path(path).name
    if (leaf.startswith('.env') and leaf != '.env.example') or Path(path).suffix.lower() in {'.pem', '.key', '.dump', '.sqlite', '.zip', '.har', '.webm', '.pyc'}:
        raise RuntimeError('SENSITIVE_PATH:'+path)
    if any(secret in raw for secret in secrets):
        raise RuntimeError('LOCAL_SECRET_VALUE:'+path)
    if re.search(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{50,}-----END', raw):
        raise RuntimeError('PRIVATE_KEY:'+path)

entries = {}
delta = {}
for path, expected in current['hashes'].items():
    raw = (root/path).read_bytes()
    if sha(raw) != expected:
        raise RuntimeError('SOURCE_DRIFT:'+path)
    if prior['hashes'].get(path) != expected:
        entries['source-delta/'+path] = raw
        delta[path] = expected
for path in evidence.rglob('*'):
    if not path.is_file():
        continue
    if path.is_symlink():
        raise RuntimeError('SYMLINK')
    rel = path.relative_to(evidence).as_posix()
    if any(p in {'original-source', 'playwright-artifacts', 'failure-context', '__pycache__'} for p in path.parts):
        continue
    if path.suffix.lower() in {'.zip', '.har', '.webm', '.pyc', '.tsbuildinfo'}:
        continue
    entries['evidence/'+rel] = path.read_bytes()
entries['REVIEW_SCOPE.json'] = (json.dumps({
    'version': 'VEINED V1.20', 'purpose': 'Brand identity candidate for owner review and subsequent external audit; not a production release',
    'baselineCheckpoint': prior['checkpoint'], 'checkpoint': current['checkpoint'],
    'sourceDelta': delta, 'execution': 'CLOSED',
    'protectedBaseline': 'cf7025aeeedac022b8ffa08540ed88345e561d23b50f05ae794f3f5dec1991b4',
    'existingDirtyWorkPreserved': True,
    'realWalletPrompts': 0, 'signatures': 0, 'approvals': 0, 'permits': 0,
    'broadcasts': 0, 'deploys': 0, 'feeCollection': 0, 'commit': False, 'push': False
}, indent=2)+'\n').encode()
for path, raw in entries.items():
    scan(path, raw)
hashes = {path: sha(raw) for path, raw in sorted(entries.items())}
inventory = (json.dumps({'checkpoint': current['checkpoint'], 'hashes': hashes}, indent=2)+'\n').encode()
name = 'VEINED_V1_20_BRAND_IDENTITY_RELEASE_CANDIDATE_REVIEW_BUNDLE.zip'
target = output/name
with zipfile.ZipFile(target, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
    for path, raw in sorted(entries.items()):
        archive.writestr(path, raw)
    archive.writestr('ENTRY_SHA256.json', inventory)
with zipfile.ZipFile(target) as archive:
    paths = archive.namelist()
    if len(paths) != len(set(p.casefold() for p in paths)) or len(paths) != len(hashes)+1 or archive.testzip() is not None:
        raise RuntimeError('ZIP_STRUCTURE_FAILED')
    for path, expected in hashes.items():
        raw = archive.read(path)
        if sha(raw) != expected:
            raise RuntimeError('ENTRY_HASH_MISMATCH:'+path)
        scan(path, raw)
    scan('ENTRY_SHA256.json', archive.read('ENTRY_SHA256.json'))
report = {
    'at': datetime.now(timezone.utc).isoformat(), 'path': str(target),
    'bytes': target.stat().st_size, 'sha256': sha(target.read_bytes()),
    'entries': len(hashes)+1, 'sourceDeltaFiles': len(delta),
    'checkpoint': current['checkpoint'], 'crcErrors': 0, 'duplicatePaths': 0,
    'secretLeaks': 0, 'secretValuesCompared': len(secrets),
    'perEntryHashesVerified': True, 'previousZipIncluded': False,
    'entryManifestSha256': sha(inventory),
    'pass': True, 'execution': 'CLOSED'
}
(output/'ZIP_VERIFICATION.json').write_text(json.dumps(report, indent=2)+'\n')
(output/(name+'.sha256')).write_text(report['sha256']+'  '+name+'\n')
print(json.dumps(report), flush=True)
