const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Compile the Icon Composer icon into a packaged macOS app's asset catalog.
 * @param {import('electron-builder').AfterPackContext} packed
 */
module.exports = ({ appOutDir, electronPlatformName, packager }) => {
  if (electronPlatformName !== 'darwin') return;
  const contents = path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents');
  // electron-builder's built-in `.icon` support targets macOS 26 whatever the app's minimum is.
  // It also ships actool's own ICNS, which stops at 256 px, as the app's icon file.
  const minimumSystem = execFileSync('plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', '-o', '-', path.join(contents, 'Info.plist')], { encoding: 'utf8' }).trim();
  const compiled = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-compile-'));
  execFileSync('actool', [
    path.join(__dirname, 'build/icon.icon'),
    '--compile', compiled,
    '--platform', 'macosx',
    '--minimum-deployment-target', minimumSystem,
    '--app-icon', 'icon',
    '--output-partial-info-plist', path.join(compiled, 'partial-info.plist'),
    '--output-format', 'human-readable-text', '--errors', '--warnings',
  ], { stdio: 'inherit' });
  fs.copyFileSync(path.join(compiled, 'Assets.car'), path.join(contents, 'Resources/Assets.car'));
  fs.rmSync(compiled, { recursive: true });
};
