import path from 'node:path';
export const dataRoot = () => process.env.AUTOSETTER_DATA_DIR || process.cwd();
export const assetRoot = () => process.env.AUTOSETTER_ASSET_DIR || process.cwd();
export const licenseFile = () => path.join(dataRoot(), 'license.json');
