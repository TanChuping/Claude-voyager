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
const JSZip = require('jszip');

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

const outDir = path.join(repoRoot, 'store_packages');
fs.mkdirSync(outDir, { recursive: true });
const xpiPath = path.join(outDir, `claude-voyager-${version}-firefox.xpi`);
if (fs.existsSync(xpiPath)) fs.rmSync(xpiPath);

// Walk the stage and build the archive in-memory.  Using JSZip — not the
// platform `zip` / Compress-Archive — guarantees forward-slash entry names
// inside the archive regardless of OS.  AMO's validator rejects entries
// like `assets\foo.js` (which PowerShell's Compress-Archive emits on
// Windows), so this matters even when the produced file installs fine.
const zip = new JSZip();
function addDir(absDir, relDir) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, entry.name);
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      addDir(abs, rel);
    } else {
      zip.file(rel, fs.readFileSync(abs));
    }
  }
}
addDir(stage, '');

(async () => {
  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  fs.writeFileSync(xpiPath, buf);

  fs.rmSync(stage, { recursive: true, force: true });

  const sizeKb = Math.round(fs.statSync(xpiPath).size / 1024);
  console.log(`[pack-firefox] ✓ ${path.relative(repoRoot, xpiPath)} (${sizeKb} KB)`);
  console.log(`[pack-firefox] Linux install: about:debugging → "This Firefox" → "Load Temporary Add-on" → pick the xpi.`);
})().catch((err) => {
  console.error('[pack-firefox] zip failed:', err);
  process.exit(1);
});
