const fs=require('node:fs/promises');
const path=require('node:path');
const {createPackage}=require('@electron/asar');
const {execFileSync}=require('node:child_process');
// All backend dependencies live in Resources/server. Keep the Electron shell
// minimal even when electron-builder discovers the parent project's packages.
module.exports=async context=>{
  const root=context.packager.projectDir;
  const resources=context.electronPlatformName==='darwin'
    ?path.join(context.appOutDir,`${context.packager.appInfo.productFilename}.app`,'Contents','Resources')
    :path.join(context.appOutDir,'resources');
  const shell=path.join(root,'.desktop',`shell-${context.arch}`);
  await fs.rm(shell,{recursive:true,force:true});await fs.mkdir(shell,{recursive:true});
  for(const file of ['main.cjs','preload.cjs','package.json'])await fs.copyFile(path.join(root,'desktop',file),path.join(shell,file));
  await fs.rm(path.join(resources,'app.asar'),{force:true});
  await fs.rm(path.join(resources,'app.asar.unpacked'),{recursive:true,force:true});
  await createPackage(shell,path.join(resources,'app.asar'));
  // Test the final resource tree, not only the pre-packaging staging directory.
  await fs.access(path.join(resources,'server','node_modules','next','package.json'));
  execFileSync(process.execPath,[path.join(root,'scripts','smoke-desktop.mjs')],{cwd:root,stdio:'inherit',env:{...process.env,AUTOSETTER_SMOKE_RESOURCES:resources}});
};
