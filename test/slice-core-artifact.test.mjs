import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceCoreArtifact } from '../scripts/slice-core-artifact.mjs';

test('slicer retains eager init order and follows references rather than property labels', async () => {
  const source = `
    /*! Retained upstream license notice */
    function __esmMin(fn) { let done=false; return () => { if(!done){done=true;fn()} }; }
    var events=[], values, init_metadata=__esmMin(()=>{values=['ready']; events.push('metadata')});
    function setWorkerDeployRuntime(runtime){events.push(runtime.label)}
    init_metadata(), setWorkerDeployRuntime({label:'registration'});
    var unusedHugeModule='should disappear', destructuredLabel='also unused';
    function runWorkerEmbeddedTurn(params) {
      const {destructuredLabel: local} = params;
      return {unusedHugeModule:local, values, events};
    }
    var init_embedded_agent_runtime=__esmMin(()=>{init_metadata();events.push('core')});
  `;
  const result = sliceCoreArtifact(source);
  assert.ok(result.source.includes('Retained upstream license notice'));
  assert.ok(!result.source.includes('should disappear'));
  assert.ok(!result.source.includes('also unused'));
  const module = await import('data:text/javascript;base64,'+Buffer.from(result.source).toString('base64'));
  assert.deepEqual(await module.runOpenClawCoreTurn({destructuredLabel:42}), {
    unusedHugeModule:42, values:['ready'], events:['metadata','registration','core'],
  });
});

test('slicer refuses a changed root or registration boundary', () => {
  assert.throws(()=>sliceCoreArtifact('function unrelated(){}'), /Missing core root/);
  assert.throws(()=>sliceCoreArtifact('function init_embedded_agent_runtime(){} function runWorkerEmbeddedTurn(){}'), /registration boundaries changed/);
});
