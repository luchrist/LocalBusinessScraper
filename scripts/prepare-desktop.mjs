import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = process.cwd();
const stage = path.join(root, '.desktop');
const server = path.join(stage, 'server');
await fs.rm(server, { recursive: true, force: true });
await fs.mkdir(server, { recursive: true });
await fs.cp(path.join(root,'.next','standalone'), server, { recursive:true,
  filter: p => !/^\.env(?:\.|$)/.test(path.basename(p)),
});
await fs.cp(path.join(root,'public'),path.join(server,'public'),{recursive:true});
await fs.cp(path.join(root,'.next','static'),path.join(server,'.next','static'),{recursive:true});
await fs.mkdir(path.join(server,'src','lib'),{recursive:true});
await fs.copyFile(path.join(root,'src','lib','llm-worker.mjs'),path.join(server,'src','lib','llm-worker.mjs'));
await fs.rm(path.join(server,'node_modules'),{recursive:true,force:true});
// Copy all runtime dependencies, including the dynamically loaded LLM worker's
// packages/native binaries. Keep Electron/build tools out of the backend tree.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packages = execFileSync(npm, ['ls','--omit=dev','--all','--parseable'], { encoding:'utf8', shell:process.platform === 'win32' }).trim().split(/\r?\n/);
for (const source of [...new Set(packages)].filter(p => p !== root && p.includes('node_modules'))) {
  const relative=path.relative(root,source);
  if (relative.startsWith('..')) throw new Error('Runtime dependency outside project: '+relative);
  await fs.cp(source,path.join(server,relative),{recursive:true,force:true,dereference:true});
}
// Runtime uses the same Node ABI as the built native modules, independently of Electron.
await fs.mkdir(path.join(stage,'runtime'),{recursive:true});
await fs.copyFile(process.execPath,path.join(stage,'runtime',process.platform==='win32'?'node.exe':'node'));
if (process.platform !== 'win32') await fs.chmod(path.join(stage,'runtime','node'),0o755);
execFileSync(process.execPath,[path.join(root,'node_modules','playwright','cli.js'),'install','chromium','--only-shell'], {
  stdio:'inherit', env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:path.join(stage,'browsers')},
});
console.log('Desktop runtime, server and Chromium prepared.');
