import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('benchmark_snapshot', ROOT / 'scripts/benchmark/benchmark_snapshot.py')
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='snapshot-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.source)], check=True)
        subprocess.run(['git', '-c', 'user.name=Snapshot test', '-c', 'user.email=snapshot@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], cwd=self.source, check=True)
        self.files = ['sdk/native.js', 'artifacts/core/benchmark-manifest.json']
        for prefix in ['', 'minified-']:
            for name in ['index', 'sdk-tool-runtime']:
                local = f'packages/openclaw-core/dist/{prefix}{name}'
                self.files.extend([local + '.mjs', local + '.manifest.json'])
                self.write(local + '.mjs', 'export const value = 1;')
                self.write(local + '.manifest.json', json.dumps({'sha256': snapshot.sha256(self.source / (local + '.mjs'))}))
        self.write('sdk/native.js', 'export const value = 1;')
        self.write('artifacts/core/benchmark-manifest.json', json.dumps({'hashes': {'sdk/native.js': snapshot.sha256(self.source / 'sdk/native.js')}}))
        self.write('node_modules/store/package/value.js', 'original package')
        (self.source / 'node_modules/package').symlink_to('store/package', target_is_directory=True)
        self.output = self.root / 'copy'
        self.files_patch = patch.object(snapshot, 'RUNTIME_FILES', self.files)
        self.trees_patch = patch.object(snapshot, 'TREES', ['node_modules'])
        self.files_patch.start(); self.trees_patch.start()
        self.addCleanup(self.files_patch.stop); self.addCleanup(self.trees_patch.stop)

    def write(self, local, text):
        target = self.source / local
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def create(self):
        snapshot.create_snapshot(self.source, self.output)
        return snapshot.Snapshot(self.output)

    def test_copies_are_independent_and_runtime_changes_are_detected(self):
        captured = self.create()
        self.write('sdk/native.js', 'new SDK')
        self.write('node_modules/store/package/value.js', 'new package')
        self.assertEqual((self.output / 'node_modules/package/value.js').read_text(), 'original package')
        captured.verify(full=True)
        (self.output / 'sdk/native.js').write_text('modified captured SDK')
        with self.assertRaisesRegex(RuntimeError, 'Snapshot runtime changed'):
            captured.verify()

    def test_external_edits_additions_and_link_changes_are_detected(self):
        captured = self.create()
        package = self.output / 'node_modules/store/package/value.js'
        package.write_text('modified dependency')
        with self.assertRaisesRegex(RuntimeError, 'dependency changed'):
            captured.verify(full=True)
        package.write_text('original package')
        added = self.output / 'node_modules/unrecorded.js'
        added.write_text('new resolution candidate')
        with self.assertRaisesRegex(RuntimeError, 'dependency changed'):
            captured.verify(full=True)
        added.unlink()
        link = self.output / 'node_modules/package'
        link.unlink(); link.symlink_to(self.source / 'node_modules/store/package')
        with self.assertRaisesRegex(ValueError, 'escapes'):
            captured.verify(full=True)

    def test_stale_builds_manifest_tampering_and_existing_destination_reject(self):
        self.write('sdk/native.js', 'unrecorded build')
        with self.assertRaisesRegex(ValueError, 'Stale benchmark'):
            self.create()
        self.assertFalse(self.output.exists())
        self.write('sdk/native.js', 'export const value = 1;')
        captured = self.create()
        with self.assertRaises(FileExistsError):
            self.create()
        manifest = self.output / snapshot.MANIFEST
        manifest.write_text(manifest.read_text() + ' ')
        with self.assertRaisesRegex(RuntimeError, 'manifest changed'):
            captured.verify()

    def test_external_and_ancestor_package_resolution_reject(self):
        (self.source / 'node_modules/escape').symlink_to('/tmp', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'escapes'):
            self.create()
        self.assertFalse(self.output.exists())
        (self.source / 'node_modules/escape').unlink()
        (self.root / 'node_modules').mkdir()
        with self.assertRaisesRegex(ValueError, 'ancestor node_modules'):
            self.create()

    def test_comparison_rejects_unfrozen_mixed_snapshots_and_mixed_entries(self):
        script = self.root / 'scripts/benchmark/compare-source-core.py'
        script.parent.mkdir(parents=True)
        script.write_bytes((ROOT / 'scripts/benchmark/compare-source-core.py').read_bytes())
        results = self.root / 'artifacts/results'
        results.mkdir(parents=True)
        def report(backend, trial, identity='same', entry=None):
            data = {'valid': True, 'entrySha256': entry or backend,
                    'runs': [], 'environment': {}, 'turns': 7, 'sampleIntervalMs': 40,
                    'benchmarkManifest': {}, 'requestLauncherSha256': 'launcher',
                    'samplerSha256': 'sampler', 'harnessSha256': 'harness'}
            if identity is not None: data['dependencySnapshot'] = {'manifestSha256': identity}
            (results / f'lifecycle-{backend}-request-cache-{trial}.json').write_text(json.dumps(data))
        def rejects(message, trials=['1']):
            result = subprocess.run(['python3', str(script), '--trials', *trials], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(message, result.stderr)
        report('sdk', 1, None)
        rejects('Unfrozen dependencies')
        report('sdk', 1); report('sdk-source', 1, 'different')
        rejects('Mixed dependency snapshots')
        report('sdk-source', 1); report('sdk', 2, entry='changed')
        rejects('Mixed core entries', ['1', '2'])


if __name__ == '__main__':
    unittest.main()
