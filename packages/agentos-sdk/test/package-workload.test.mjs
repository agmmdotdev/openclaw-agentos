import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { AgentOs } from '../dist/native-entry.js';

// Real packages from the pinned OpenClaw dependency closure. Mock transports
// avoid external services; this is trusted Node compatibility, not containment.
const packageRequire = createRequire(realpathSync(new URL('../../../node_modules/openclaw/package.json', import.meta.url)));
function installedPackage(name) {
  let dir = dirname(packageRequire.resolve(name));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (manifest.name === name) return { dir, version: manifest.version };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Package root missing: ${name}`);
    dir = parent;
  }
}

test('ESM skill-style workflow uses real validation, YAML, HTTP and AWS packages through native SDK', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-packages-'));
  const vm = await AgentOs.create({ backend: 'native-node', workspaceDir: root, security: 'trusted-only' });
  t.after(async () => { await vm.dispose(); await rm(root, { recursive: true, force: true }); });
  const versions = {};
  for (const name of ['zod', 'yaml', 'ajv', 'minimatch', 'undici', '@aws-sdk/client-s3']) {
    const pkg = installedPackage(name); versions[name] = pkg.version;
    const destination = join(root, 'node_modules', name);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(pkg.dir, destination, 'dir');
  }
  await vm.filesystem.writeFile('config.yaml', 'name: မြန်မာ 🐈\nfiles:\n  - src/a.ts\n  - src/b.js\n');
  const script = `
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {z} from 'zod';
import YAML from 'yaml';
import Ajv from 'ajv';
import {minimatch} from 'minimatch';
import {MockAgent,fetch} from 'undici';
import {S3Client,ListBucketsCommand} from '@aws-sdk/client-s3';
const schema=z.object({name:z.string(),files:z.array(z.string())}).strict();
const config=schema.parse(YAML.parse(await readFile('config.yaml','utf8')));
assert.equal(schema.safeParse({name:42,files:[]}).success,false);
const validate=new Ajv().compile({type:'object',properties:{name:{type:'string'},files:{type:'array',items:{type:'string'}}},required:['name','files'],additionalProperties:false});
assert.equal(validate(config),true);assert.equal(validate({name:42,files:[]}),false);
const files=config.files.filter(file=>minimatch(file,'src/*.ts'));
assert.deepEqual(files,['src/a.ts']);
const dispatcher=new MockAgent();dispatcher.disableNetConnect();
dispatcher.get('https://fixture.invalid').intercept({method:'POST',path:'/echo',body:JSON.stringify(config)}).reply(200,{name:config.name},{headers:{'content-type':'application/json'}});
try{const response=await fetch('https://fixture.invalid/echo',{method:'POST',body:JSON.stringify(config),dispatcher});assert.equal(response.status,200);assert.equal((await response.json()).name,config.name);dispatcher.assertNoPendingInterceptors();}finally{await dispatcher.close();}
let requests=0;
const client=new S3Client({region:'us-east-1',credentials:{accessKeyId:'TEST_ONLY_ACCESS',secretAccessKey:'test-only-not-a-secret'},requestHandler:{async handle(request){requests++;assert.equal(request.method,'GET');assert.match(request.headers.authorization,/Credential=TEST_ONLY_ACCESS\\//);return {response:{statusCode:200,headers:{'content-type':'application/xml'},body:Readable.from(['<ListAllMyBucketsResult><Buckets><Bucket><Name>fixture-bucket</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>'])}}}}});
let buckets;try{buckets=(await client.send(new ListBucketsCommand({}))).Buckets.map(x=>x.Name);}finally{client.destroy();}
assert.equal(requests,1);assert.deepEqual(buckets,['fixture-bucket']);
const report={name:config.name,files,buckets,args:process.argv.slice(2)};
await writeFile('package-report.json',JSON.stringify(report));console.log(JSON.stringify(report));
`;
  await writeFile(join(root, 'skill.mjs'), script);
  const direct = spawnSync(process.execPath, ['skill.mjs', 'argument with spaces 🐈'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(direct.status, 0, direct.stderr);
  const result = await vm.javascript.executeFile('skill.mjs', { args: ['argument with spaces 🐈'], output: { capture: 'all' } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, direct.stdout);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'package-report.json'), 'utf8')), JSON.parse(result.stdout));
  t.diagnostic(JSON.stringify({ versions, externalNetwork: false, trustedOnly: true }));
});

test('installed packages expose CommonJS entry points through native SDK', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-package-cjs-'));
  const vm = await AgentOs.create({ backend: 'native-node', workspaceDir: root, security: 'trusted-only' });
  t.after(async () => { await vm.dispose(); await rm(root, { recursive: true, force: true }); });
  for (const name of ['zod', 'yaml', 'ajv', 'minimatch', 'undici', '@aws-sdk/client-s3']) {
    const destination = join(root, 'node_modules', name);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(installedPackage(name).dir, destination, 'dir');
  }
  await vm.filesystem.writeFile('skill.cjs', `const assert=require('node:assert/strict');assert.equal(require('zod').z.string().parse('ok'),'ok');assert.equal(require('yaml').parse('a: 1').a,1);for(const [pkg,key] of [['ajv','default'],['minimatch','minimatch'],['undici','fetch'],['@aws-sdk/client-s3','S3Client']])assert.equal(typeof require(pkg)[key],'function');console.log('CommonJS packages passed');`);
  const result = await vm.javascript.executeFile('skill.cjs', { output: { capture: 'all' } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'CommonJS packages passed');
});
