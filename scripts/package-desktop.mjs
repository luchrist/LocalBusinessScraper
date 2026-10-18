import { execFileSync } from 'node:child_process';
import path from 'node:path';
const env={...process.env};
// GitHub supplies missing optional secrets as empty strings. electron-builder
// treats an empty certificate link as the current directory, so omit it.
for(const key of ['CSC_LINK','CSC_KEY_PASSWORD','WIN_CSC_LINK','WIN_CSC_KEY_PASSWORD','APPLE_ID','APPLE_APP_SPECIFIC_PASSWORD','APPLE_TEAM_ID']) {
  if(!env[key]?.trim())delete env[key];
}
execFileSync(process.execPath,[path.join(process.cwd(),'node_modules/electron-builder/out/cli/cli.js'),...process.argv.slice(2),'--publish','never'],{stdio:'inherit',env});
