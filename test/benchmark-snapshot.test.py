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
            local = f'artifacts/core/{prefix}source-native-sdk-core-benchmark.mjs'
            self.files.append(local)
            self.write(local, 'export const fixture = true;')
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

    def test_baseline_is_explicit_complete_and_manifest_validated(self):
        with self.assertRaises(FileNotFoundError):
            snapshot.create_snapshot(self.source, self.output, include_baseline_minified=True)
        self.assertFalse(self.output.exists())
        for local in snapshot.source_runtime_files('baseline-minified'):
            original = self.source / local.replace('baseline-minified-', 'minified-')
            self.write(local, original.read_text())
        for name in ['index', 'sdk-tool-runtime']:
            local = f'packages/openclaw-core/dist/baseline-minified-{name}.manifest.json'
            original = (self.source / local).read_text()
            self.write(local, json.dumps({'sha256': 'stale'}))
            with self.assertRaisesRegex(ValueError, 'Stale core build manifest'):
                snapshot.create_snapshot(self.source, self.output, include_baseline_minified=True)
            self.assertFalse(self.output.exists())
            self.write(local, original)
        snapshot.create_snapshot(self.source, self.output, include_baseline_minified=True)
        captured = snapshot.Snapshot(self.output)
        captured.require_source_layout('baseline-minified')
        self.assertEqual(captured.manifest['sourceLayouts'], list(snapshot.SOURCE_LAYOUTS))
        for local in snapshot.source_runtime_files('baseline-minified'):
            self.assertIn(local, captured.manifest['files'])
        missing = 'packages/openclaw-core/dist/baseline-minified-sdk-tool-runtime.mjs'
        del captured.manifest['files'][missing]
        with self.assertRaisesRegex(ValueError, 'Source artifact not captured'):
            captured.require_source_layout('baseline-minified')

    def test_snapshot_rejects_uncaptured_and_unknown_source_layouts(self):
        captured = self.create()
        captured.require_source_layout('standard')
        captured.require_source_layout('minified')
        with self.assertRaisesRegex(ValueError, 'Source layout not captured'):
            captured.require_source_layout('baseline-minified')
        for layout in ['unknown', '../minified', 'minified/../../other']:
            with self.assertRaisesRegex(ValueError, 'Unsupported snapshot source layout'):
                captured.require_source_layout(layout)

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

    def test_initialization_comparison_validates_frozen_variants_and_both_modes(self):
        script = self.root / 'scripts/benchmark/summarize-source-initialization.py'
        script.parent.mkdir(parents=True)
        script.write_bytes((ROOT / 'scripts/benchmark/summarize-source-initialization.py').read_bytes())
        results = self.root / 'artifacts/results'
        results.mkdir(parents=True)

        def reports(mode):
            paths = {}
            for name, layout, cpu in [('before', 'baseline-minified', 10), ('after', 'minified', 8), ('merged', None, 9)]:
                backend = 'sdk-source' if layout else 'sdk'
                label = backend + ('-'+layout if layout else '')
                data = {'valid': True, 'backend': backend, 'mode': mode, 'trial': 1,
                        'entrySha256': name, 'environment': {}, 'turns': 7, 'sampleIntervalMs': 40,
                        'benchmarkManifest': {}, 'requestLauncherSha256': 'launcher',
                        'samplerSha256': 'sampler', 'harnessSha256': 'harness',
                        'dependencySnapshot': {'manifestSha256': 'same', 'filesSha256': 'files'},
                        'summary': {'totalCpuSeconds': cpu, 'peakPssMiB': 100, 'firstProcessMs': 30,
                                    'subsequentProcessMedianMs': 20 if mode == 'request-cache' else None,
                                    'subsequentCpuMedianSeconds': 1 if mode == 'request-cache' else None,
                                    'warmTurnMedianMs': 5, 'idleCorePssMiB': 80 if mode == 'resident' else 0},
                        'runs': [{'logs': [], 'wallMs': 30, 'cpuSeconds': 2, 'peakPssMiB': 100}]
                                * (7 if mode == 'request-cache' else 1)}
                if layout:
                    data.update(sourceLayout=layout, sourceCoreSha256=name,
                                sourceCoreManifest={'sha256': name}, sourceToolRuntimeSha256='runtime',
                                sourceToolRuntimeManifest={'sha256': 'runtime'}, sourceFixtureBuilderSha256='builder')
                path = results / f'lifecycle-{label}-{mode}-1.json'
                path.write_text(json.dumps(data)); paths[name] = path
            return paths

        def run(mode):
            return subprocess.run(['python3', str(script), '--before-trials', '1', '--after-trials', '1', '--mode', mode], capture_output=True, text=True)

        for mode in ['request-cache', 'resident']:
            paths = reports(mode)
            result = run(mode)
            self.assertEqual(result.returncode, 0, result.stderr)
            summary = json.loads(result.stdout)
            self.assertAlmostEqual(summary['afterVsBeforePercent']['totalCpuSeconds'], -20)
            self.assertEqual('cachedProcessPeakPssMiB' in summary['summary']['after'], mode == 'request-cache')
            self.assertEqual(summary['snapshotManifestSha256'], 'same')
            original = json.loads(paths['after'].read_text())
            for change, message in [
                ({'dependencySnapshot': None}, 'Unfrozen dependencies'),
                ({'dependencySnapshot': {'manifestSha256': 'different'}}, 'Mixed dependency snapshots'),
                ({'dependencySnapshot': {'manifestSha256': 'same', 'filesSha256': 'different'}}, 'Unmatched dependencySnapshot'),
                ({'sourceCoreManifest': {'sha256': 'stale'}}, 'Stale source manifest'),
                ({'sourceToolRuntimeManifest': {'sha256': 'stale'}}, 'Stale source manifest'),
                ({'sourceLayout': 'baseline-minified'}, 'Mismatched source layout'),
                ({'environment': {'cpus': [9]}}, 'Unmatched environment'),
            ]:
                paths['after'].write_text(json.dumps({**original, **change}))
                result = run(mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
            paths['after'].write_text(json.dumps(original))


if __name__ == '__main__':
    unittest.main()
