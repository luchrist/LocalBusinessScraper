import { execFileSync } from 'node:child_process';
import path from 'node:path';
const env={...process.env};
// GitHub supplies missing optional secrets as empty strings. electron-builder
// treats an empty certificate link as the current directory, so omit it.
for(const key of ['CSC_LINK','CSC_KEY_PASSWORD','WIN_CSC_LINK','WIN_CSC_KEY_PASSWORD','APPLE_ID','APPLE_APP_SPECIFIC_PASSWORD','APPLE_TEAM_ID']) {
  if(!env[key]?.trim())delete env[key];
}
const args=process.argv.slice(2);
// Apple Silicon requires a valid bundle signature even for local test builds.
// CI without a release certificate uses ad-hoc signing; local release builds
// can discover the owner's Developer ID certificate as usual.
if(process.platform==='darwin' && !env.CSC_LINK && (env.CI==='true' || env.CSC_IDENTITY_AUTO_DISCOVERY==='false'))args.push('-c.mac.identity=-');
execFileSync(process.execPath,[path.join(process.cwd(),'node_modules/electron-builder/out/cli/cli.js'),...args,'--publish','never'],{stdio:'inherit',env});
