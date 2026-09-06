// Run from repository root with the pinned upstream checkout as argv[2].
const ts=require(process.cwd()+'/node_modules/typescript');const fs=require('fs');
const upstream=process.argv[2];if(!upstream)throw Error('Usage: node packages/agentos-sdk/scripts/extract-surface.cjs /path/to/pinned/agentos');
const cp=require('child_process');if(cp.execFileSync('git',['-C',upstream,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!=='9ae6abbdc48391a75b8336e7832b3e76f42616ee')throw Error('Upstream source commit mismatch');
if(JSON.parse(fs.readFileSync('node_modules/@rivet-dev/agentos-core/package.json','utf8')).version!=='0.2.19')throw Error('Installed SDK release mismatch');
const decl=fs.readFileSync('node_modules/@rivet-dev/agentos-core/dist/agent-os.d.ts','utf8');const ast=ts.createSourceFile('agent-os.d.ts',decl,ts.ScriptTarget.Latest,true);
const cls=ast.statements.find(s=>ts.isClassDeclaration(s)&&s.name.text==='AgentOs');
const selections={filesystem:['readFile','writeFile','readFiles','writeFiles','stat','mkdir','readdir','readdirEntries','readdirRecursive','exists','move','remove'],process:['spawn','wait','get','list','tree','signal','kill','writeStdin','closeStdin','readOutput','exec','execFile'],javascript:['execute','executeFile','spawn','spawnFile']};
let out='// Public API slice extracted from agentOS 0.2.19 declarations (Apache-2.0).\nimport type { ProcessDescriptor, ProcessExit, SpawnOptions, LanguageExecutionOptions, CodeExecutionResult, ExecutionSignal, OutputReplay, JavaScriptExecutionOptions, LanguageSpawnOptions } from "./language-execution.js";\n';
for(const [name,methods]of Object.entries(selections)){const property=cls.members.find(m=>m.name?.getText(ast)===name);out+='export interface '+({filesystem:'FileApi',process:'ProcessApi',javascript:'JavaScriptApi'}[name])+' {\n'+property.type.members.filter(m=>methods.includes(m.name?.getText(ast))).map(m=>m.getText(ast)).join('\n')+'\n}\n';}
const source=fs.readFileSync(upstream+'/packages/core/src/agent-os.ts','utf8');const src=ts.createSourceFile('source.ts',source,ts.ScriptTarget.Latest,true);
for(const s of src.statements)if(ts.isInterfaceDeclaration(s)&&['ProcessTreeNode','DirEntry','ReaddirEntry','ReaddirRecursiveOptions','BatchWriteEntry','BatchWriteResult','BatchReadResult'].includes(s.name.text))out+=s.getText(src)+'\n';
const runtime=ts.createSourceFile('runtime.ts',fs.readFileSync(upstream+'/packages/core/src/runtime-compat.ts','utf8'),ts.ScriptTarget.Latest,true);out+=runtime.statements.find(s=>ts.isInterfaceDeclaration(s)&&s.name.text==='VirtualStat').getText(runtime)+'\n';
fs.writeFileSync('packages/agentos-sdk/src/sdk-surface.ts',out);
