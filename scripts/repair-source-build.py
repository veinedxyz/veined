"""Bounded public source acquisition only. No network transaction or deployment."""
import datetime
import hashlib
import io
import json
import pathlib
import urllib.request
import zipfile
import sys
import re

repo = pathlib.Path.cwd().resolve()
base = repo / 'evidence/otherbridge-v1/repair-r1/sources'
run = sys.argv[1] if len(sys.argv) > 1 else 'a'
if not re.fullmatch('[a-z0-9-]+', run): raise RuntimeError('INVALID_RUN_NAME')
cache = repo / ('.otherbridge/research-r1/source-build' if run == 'a' else f'.otherbridge/research-r1/source-build-{run}')
if cache.exists():
    raise RuntimeError('Existing research cache preserved; choose a new run')
cache.mkdir(parents=True)
requests = []


def fetch(url, limit=12000000):
    item = {'url': url, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    requests.append(item)
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Otherbridge-readonly-source-review'}), timeout=20) as response:
        item['status'] = response.status
        data = response.read(limit + 1)
        if len(data) > limit:
            raise RuntimeError('RESPONSE_SIZE_LIMIT')
        item['bytes'] = len(data)
        item['sha256'] = hashlib.sha256(data).hexdigest()
        return data


def archive(repository, commit, directory):
    data = fetch(f'https://codeload.github.com/{repository}/zip/{commit}')
    destination = cache / directory
    destination.mkdir()
    with zipfile.ZipFile(io.BytesIO(data)) as source:
        total = 0
        for entry in source.infolist():
            total += entry.file_size
            if total > 50000000:
                raise RuntimeError('ARCHIVE_SIZE_LIMIT')
            parts = pathlib.PurePosixPath(entry.filename).parts[1:]
            if not parts or entry.is_dir():
                continue
            if '..' in parts or entry.filename.startswith('/') or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise RuntimeError('UNSAFE_ARCHIVE_ENTRY')
            target = destination.joinpath(*parts)
            if not target.resolve().is_relative_to(destination.resolve()):
                raise RuntimeError('UNSAFE_ARCHIVE_PATH')
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as output:
                output.write(source.read(entry))
    return directory


builds = []
libraries = {}
selections = [('current-legacy', '3a8347cd005d00e50af9194204a55da69f96ddfc')] if run == 'current' else [('pre-unification', '34019062c601a6b78812a983dce0b4dc003a9c2f'), ('april-2025', '36e27b9ffe52f7888f56d0ad70a0bdbc2b569471')]
for label, commit in selections:
    tree = json.loads(fetch(f'https://api.github.com/repos/to-nexus/bridge-contracts/git/trees/{commit}?recursive=1', 2000000))
    project = archive('to-nexus/bridge-contracts', commit, label)
    dependencies = {}
    for entry in tree['tree']:
        path = entry['path']
        if entry['type'] != 'commit' or path not in ['lib/openzeppelin-contracts', 'lib/openzeppelin-contracts-upgradeable']:
            continue
        name = path.split('/')[-1]
        key = f'{name}-{entry["sha"]}'
        if key not in libraries:
            libraries[key] = archive(f'OpenZeppelin/{name}', entry['sha'], key)
        dependencies[path] = {'commit': entry['sha'], 'directory': libraries[key]}
    builds.append({'label': label, 'commit': commit, 'projectDirectory': project, 'dependencies': dependencies})
release = json.loads((base / 'solc-0.8.28-official-release.json').read_text())
prior_compiler = repo / '.otherbridge/research-r1/source-build/soljson.cjs'
compiler = prior_compiler.read_bytes() if run != 'a' and prior_compiler.exists() else fetch(f'https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages/bin/{release["path"]}', 16000000)
if hashlib.sha256(compiler).hexdigest() != release['sha256'].removeprefix('0x'):
    raise RuntimeError('COMPILER_HASH_MISMATCH')
with (cache / 'soljson.cjs').open('xb') as output:
    output.write(compiler)
manifest = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'cache': str(cache), 'builds': builds, 'compiler': release,
            'requests': requests, 'signatures': 0, 'broadcasts': 0, 'deployments': 0}
with (base / ('historical-build-inputs.json' if run == 'a' else f'historical-build-inputs-{run}.json')).open('x') as output:
    json.dump(manifest, output, indent=2)
print(json.dumps({'cache': str(cache), 'builds': [b['label'] for b in builds], 'requests': len(requests)}))
