#!/usr/bin/env node
/**
 * Build a Firefox-installable .xpi from dist_firefox/.
 *
 * An XPI is just a zip with a particular layout — same content as the
 * Chrome zip, but Firefox-specific (uses background.scripts instead of
 * service_worker, gecko id from browser_specific_settings, mermaid-legacy
 * alias from vite.config.firefox.ts so we don't pull v11+ ESM that
 * Firefox's parser can choke on).
 *
 * The Chrome-only `key` field (locally inlined for stable unpacked dev
 * ID) is stripped — Firefox ignores it, but AMO submission rejects it
 * the same way Chrome Web Store does.
 *
 * Usage:
 *   bun run build:firefox            # produces dist_firefox/
 *   node scripts/pack-firefox.cjs    # produces claude-voyager-<ver>-firefox.xpi
 *
 * Install paths on Linux:
 *  - Firefox stable (any distro): `about:debugging` → "This Firefox" →
 *    "Load Temporary Add-on" → select the xpi.  Resets on browser
 *    restart, no signing needed.
 *  - Firefox Developer Edition or Nightly with `xpinstall.signatures
 *    .required = false`: drag the xpi onto the Firefox window.
 *  - Stable distribution: submit the xpi to addons.mozilla.org for
 *    Mozilla signing; the signed artefact then installs in any Firefox.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const dist = path.join(repoRoot, 'dist_firefox');
const stage = path.join(repoRoot, '.tmp_firefox_stage');

if (!fs.existsSync(dist)) {
  console.error(`[pack-firefox] dist_firefox/ missing — run \`bun run build:firefox\` first.`);
  process.exit(1);
}

const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = pkgJson.version;
console.log(`[pack-firefox] version: ${version}`);

if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(sp, dp);
    else fs.copyFileSync(sp, dp);
  }
}
copyDir(dist, stage);

// Strip `key` + rewrite as UTF-8 NO BOM.
const manifestPath = path.join(stage, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const hadKey = 'key' in manifest;
delete manifest.key;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { encoding: 'utf8' });
console.log(`[pack-firefox] manifest 'key' field: ${hadKey ? 'stripped' : 'absent (ok)'}`);

const xpiPath = path.join(repoRoot, `claude-voyager-${version}-firefox.xpi`);
if (fs.existsSync(xpiPath)) fs.rmSync(xpiPath);

const isWin = process.platform === 'win32';
let res;
if (isWin) {
  // PowerShell's Compress-Archive only accepts .zip destinations, so we
  // zip to a temp .zip path then rename to .xpi (same bytes, the rename
  // is purely cosmetic for Firefox's file-pickers).
  // Compress-Archive insists on the literal `.zip` extension, so we
  // stage at a plain .zip path and rename afterwards.
  const tmpZip = xpiPath.replace(/\.xpi$/, '.firefox-stage.zip');
  if (fs.existsSync(tmpZip)) fs.rmSync(tmpZip);
  res = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${stage}\\*' -DestinationPath '${tmpZip}' -Force`,
    ],
    { stdio: 'inherit' },
  );
  if (res.status === 0) fs.renameSync(tmpZip, xpiPath);
} else {
  res = spawnSync('zip', ['-r', xpiPath, '.'], { stdio: 'inherit', cwd: stage });
}
if (res.status !== 0) {
  console.error(`[pack-firefox] zip failed (status ${res.status})`);
  process.exit(res.status ?? 1);
}

fs.rmSync(stage, { recursive: true, force: true });

const sizeKb = Math.round(fs.statSync(xpiPath).size / 1024);
console.log(`[pack-firefox] ✓ ${path.basename(xpiPath)} (${sizeKb} KB)`);
console.log(`[pack-firefox] Linux install: about:debugging → "This Firefox" → "Load Temporary Add-on" → pick the xpi.`);
