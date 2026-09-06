// Real OpenClaw tools through the extracted SDK; trusted-only, not a security test.
const assert=(x,m)=>{if(!x)throw new Error(m);};
const root=process.env.BENCH_ROOT+'/workspace';
const tools=createCoreCodingTools({codingRoot:root,includeBaseCodingTools:true,includeShellTools:true,
 execDefaults:{security:'full',ask:'off',allowBackground:true,scopeKey:'native-sdk-probe',sessionKey:'agent:benchmark:main',commandHighlighting:false},processDefaults:{scopeKey:'native-sdk-probe'},imageSanitization:{}});
async function call(name,args){const r=await tools.find(t=>t.name===name).execute('probe-'+name,args);assert(!r.isError,JSON.stringify(r));return r;}
await call('write',{path:root+'/check.txt',content:'before\n'});
await call('edit',{path:root+'/check.txt',edits:[{oldText:'before',newText:'after'}]});
assert((await call('read',{path:root+'/check.txt'})).content.some(c=>c.text?.includes('after')),'read/edit mismatch');
assert(fs.readFileSync(root+'/check.txt','utf8')==='after\n','native file persistence mismatch');
const q="'"+(root+'/check.txt').replaceAll("'","'\\''")+"'";
const result=await call('exec',{command:'cat '+q+'; exit 7',workdir:root});
assert(result.details.exitCode===7&&result.content.some(c=>c.text?.includes('after')),'shell output/exit mismatch');
const timeout=await call('exec',{command:'sleep 5',workdir:root,timeoutSeconds:1});
assert(timeout.details.timedOut,JSON.stringify(timeout));
console.log('NATIVE_SDK_PROBE=passed; security=trusted-only; sandboxed=false');
