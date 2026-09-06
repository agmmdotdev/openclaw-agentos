import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { release, arch } from 'node:os';
export async function inspectLinuxCapabilities() {
 const read = async (p:string) => { try { return (await readFile(p,'utf8')).trim(); } catch (e) { return { unavailable: (e as NodeJS.ErrnoException).code }; } };
 let landlock: unknown;
 try { const {stdout}=await promisify(execFile)(fileURLToPath(new URL('./linux-preflight',import.meta.url)),[],{timeout:5000}); landlock=JSON.parse(stdout); }
 catch(e) { landlock={unavailable:(e as NodeJS.ErrnoException).code ?? String(e)}; }
 let cgroupWritable=false;
 try { await access('/sys/fs/cgroup',constants.W_OK); cgroupWritable=true; } catch { /* reported below as unavailable, not treated as enforced */ }
 const status=await read('/proc/self/status');
 return { platform:process.platform, kernel:release(), architecture:arch(), landlock,
 cgroupControllers:await read('/sys/fs/cgroup/cgroup.controllers'),cgroupSubtreeControl:await read('/sys/fs/cgroup/cgroup.subtree_control'),cgroupWritable,
 processSecurity:typeof status==='string'?status.split('\n').filter(x=>/^(CapEff|CapBnd|NoNewPrivs|Seccomp):/.test(x)):status,
 // launcherImplemented describes the production SDK path, not test-only helpers.
 launcherImplemented:false, sandboxEnforcementVerified:false,
 experimentalLauncher:{implemented:true,sdkIntegrated:false,minimumLandlockAbi:6,architecture:'x64',acceptance:'unverified'} };
}
