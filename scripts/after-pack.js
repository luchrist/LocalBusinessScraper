/**
 * electron-builder afterPack hook.
 * Copies .next/static into the standalone directory so Next.js can serve assets.
 */
const path = require('path');
const fs = require('fs');

exports.default = async function (context) {
  const appDir = context.appOutDir;
  const resourcesDir = path.join(appDir, process.platform === 'darwin' ? 'Local Business Scraper.app/Contents/Resources/app' : 'resources/app');

  const staticSrc = path.join(__dirname, '..', '.next', 'static');
  const staticDst = path.join(resourcesDir, '.next', 'standalone', '.next', 'static');

  if (fs.existsSync(staticSrc) && !fs.existsSync(staticDst)) {
    console.log('Copying .next/static into standalone bundle...');
    fs.cpSync(staticSrc, staticDst, { recursive: true });
  }

  const publicSrc = path.join(__dirname, '..', 'public');
  const publicDst = path.join(resourcesDir, '.next', 'standalone', 'public');
  if (fs.existsSync(publicSrc) && !fs.existsSync(publicDst)) {
    console.log('Copying public/ into standalone bundle...');
    fs.cpSync(publicSrc, publicDst, { recursive: true });
  }
};
