"""Copied runtime inputs and provenance for trusted, serial SDK comparisons.

Hashing and copying happen outside measured workers. This is reproducibility
infrastructure, not a security boundary or a snapshot of the host OS.
"""
import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
from pathlib import Path

VERSION = 1
MANIFEST = 'benchmark-snapshot.json'
RUNTIME_FILES = [
    'package.json', 'pnpm-lock.yaml',
    'packages/agentos-sdk/package.json', 'packages/openclaw-core/package.json',
    'packages/openclaw-core/package-lock.json',
    'packages/openclaw-core/src/request-state.mjs',
    'scripts/benchmark/native-sdk-adapter.mjs',
    'scripts/benchmark/request-lifecycle.py', 'scripts/benchmark/process_metrics.py',
    'scripts/benchmark/benchmark_snapshot.py', 'scripts/benchmark/build.mjs',
    'scripts/benchmark/build-source-core.mjs',
    'scripts/run-core-node-request.sh', 'scripts/run-core-node-request.mjs',
    'scripts/core/request-profile-guard.mjs',
    'test/fixtures/core-benchmark.mjs', 'test/fixtures/core-workload-benchmark.mjs',
    'artifacts/core/benchmark-manifest.json', 'artifacts/core/manifest.json',
    'artifacts/core/native-sdk-core-benchmark.mjs', 'artifacts/core/native-highlight.cjs',
    'artifacts/core/web-tree-sitter.wasm', 'packages/openclaw-core/dist/web-tree-sitter.wasm',
]
for prefix in ['', 'minified-']:
    RUNTIME_FILES.append(f'artifacts/core/{prefix}source-native-sdk-core-benchmark.mjs')
    for name in ['index', 'sdk-tool-runtime']:
        for suffix in ['mjs', 'manifest.json']:
            RUNTIME_FILES.append(f'packages/openclaw-core/dist/{prefix}{name}.{suffix}')
TREES = ['node_modules', 'packages/openclaw-core/node_modules', 'packages/agentos-sdk/dist',
         'artifacts/core/node_modules', 'packages/openclaw-core/dist/node_modules']


def sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def inventory(root):
    """Include names, file content, modes and symlinks; never follow directory links."""
    root = Path(root).resolve()
    entries = {}
    for directory, dirs, files in os.walk(root):
        for name in sorted(dirs + files):
            path = Path(directory) / name
            local = path.relative_to(root).as_posix()
            if local == MANIFEST:
                continue
            info = path.lstat()
            mode = stat.S_IMODE(info.st_mode)
            if path.is_symlink():
                target = os.readlink(path)
                if os.path.isabs(target) or not path.resolve().is_relative_to(root):
                    raise ValueError(f'Snapshot link escapes its root: {local}')
                entries[local] = {'kind': 'link', 'target': target}
            elif path.is_file():
                entries[local] = {'kind': 'file', 'bytes': info.st_size, 'mode': mode, 'sha256': sha256(path)}
            elif path.is_dir():
                entries[local] = {'kind': 'directory', 'mode': mode}
            else:
                raise ValueError(f'Unsupported snapshot entry: {local}')
    return entries


def check_parent_resolution(root):
    if any((parent / 'node_modules').exists() for parent in root.parents):
        raise ValueError('Snapshot has an ancestor node_modules; resolution could escape the copy')


def create_snapshot(source, destination):
    source, destination = Path(source).resolve(), Path(destination).absolute()
    if destination.exists():
        raise FileExistsError('Snapshot destination already exists')
    # A separate root prevents accidental fallback to the checkout's node_modules.
    if destination.is_relative_to(source):
        raise ValueError('Snapshot must be outside the source checkout')
    check_parent_resolution(destination)
    destination.mkdir(parents=True)
    try:
        for local in RUNTIME_FILES:
            target = destination / local
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / local, target)
        for local in TREES:
            shutil.copytree(source / local, destination / local, symlinks=True)
        # Keep package-manager links internal; reject external/absolute links.
        entries = inventory(destination)
        for prefix in ['', 'minified-']:
            for name in ['index', 'sdk-tool-runtime']:
                local = f'packages/openclaw-core/dist/{prefix}{name}'
                if json.loads((destination / (local + '.manifest.json')).read_text())['sha256'] != sha256(destination / (local + '.mjs')):
                    raise ValueError(f'Stale core build manifest: {local}')
        for local, expected in json.loads((destination / 'artifacts/core/benchmark-manifest.json').read_text())['hashes'].items():
            if local in entries and entries[local].get('sha256') != expected:
                raise ValueError(f'Stale benchmark build manifest: {local}')
        node = Path(shutil.which('node')).resolve()
        manifest = {'version': VERSION, 'files': entries, 'filesSha256': digest(entries),
                    'node': {'path': str(node), 'sha256': sha256(node),
                             'version': subprocess.check_output([str(node), '--version'], text=True).strip()},
                    'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip(),
                    'method': 'Independent copies; internal relative package links; full content verification before/after each trial; runtime file verification between requests; OS libraries and tool executables are not copied.'}
        (destination / MANIFEST).write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
        return manifest
    except BaseException:
        shutil.rmtree(destination)
        raise


class Snapshot:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.manifest_path = self.root / MANIFEST
        self.manifest_sha256 = sha256(self.manifest_path)
        self.manifest = json.loads(self.manifest_path.read_text())
        if self.manifest['version'] != VERSION or digest(self.manifest['files']) != self.manifest['filesSha256']:
            raise ValueError('Invalid snapshot inventory')
        self.verify(full=True)

    def verify(self, full=False):
        check_parent_resolution(self.root)
        if sha256(self.manifest_path) != self.manifest_sha256:
            raise RuntimeError('Snapshot manifest changed')
        expected = self.manifest['files']
        if full:
            if inventory(self.root) != expected:
                raise RuntimeError('Snapshot dependency changed; comparison rejected')
            if sha256(self.manifest['node']['path']) != self.manifest['node']['sha256']:
                raise RuntimeError('Node executable changed')
        else:
            # The full external tree is checked at trial boundaries. This smaller
            # set covers rebuildable code/assets between measured requests.
            for local, info in expected.items():
                if local.startswith(('node_modules/', 'packages/openclaw-core/node_modules/')):
                    continue
                path = self.root / local
                if info['kind'] == 'file' and (path.is_symlink() or sha256(path) != info['sha256']):
                    raise RuntimeError(f'Snapshot runtime changed: {local}')

    def provenance(self):
        return {'version': VERSION, 'manifestSha256': self.manifest_sha256,
                'filesSha256': self.manifest['filesSha256'], 'fileCount': len(self.manifest['files']),
                'node': self.manifest['node'], 'sourceCommit': self.manifest['sourceCommit']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = create_snapshot(args.source, args.output)
    print(json.dumps({'output': str(args.output), 'filesSha256': result['filesSha256'],
                      'fileCount': len(result['files'])}))
