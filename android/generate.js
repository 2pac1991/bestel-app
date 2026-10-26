// Erzeugt das Android-Projekt (Trusted Web Activity) aus twa-manifest.json.
// Läuft in GitHub Actions: node android/generate.js <versionCode>
const path = require('path');
const { TwaManifest, TwaGenerator, ConsoleLog } = require('@bubblewrap/core');

(async () => {
  const versionCode = parseInt(process.argv[2] || '1', 10);
  const manifest = await TwaManifest.fromFile(path.join(__dirname, 'twa-manifest.json'));
  manifest.appVersionCode = versionCode;
  manifest.appVersionName = `1.0.${versionCode}`;
  const out = path.join(__dirname, 'build');
  await new TwaGenerator().createTwaProject(out, manifest, new ConsoleLog('generate'));
  console.log(`Projekt erzeugt in ${out} (Version ${manifest.appVersionName})`);
})().catch(err => { console.error(err); process.exit(1); });
