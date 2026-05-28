#!/usr/bin/env node
/**
 * Build a Chrome Web Store-ready zip from dist_chrome/.
 *
 * The Web Store rejects manifests that contain a top-level `key` field —
 * that field is for LOCAL unpacked installs only (it locks the extension
 * ID across reloads so the user's stored data survives rebuilds).  Once
 * the store accepts the upload, it assigns its own ID, so the key has to
 * be stripped before submission.
 *
 * Usage:
 *   bun run build:chrome          # produces dist_chrome/ (with `key`)
 *   node scripts/pack-webstore.cjs  # produces claude-voyager-<ver>.zip
 *
 * Output: store_packages/claude-voyager-<version>.zip.
 */

const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');

const repoRoot = path.resolve(__dirname, '..');
const dist = path.join(repoRoot, 'dist_chrome');
const stage = path.join(repoRoot, '.tmp_store_stage');

if (!fs.existsSync(dist)) {
  console.error(`[pack-webstore] dist_chrome/ missing — run \`bun run build:chrome\` first.`);
  process.exit(1);
}

// 1. Read the version
const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = pkgJson.version;
console.log(`[pack-webstore] version: ${version}`);

// 2. Fresh stage dir
if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// 3. Copy dist_chrome contents to stage (recursive)
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

// 4. Strip `key` field from manifest.json, write back as UTF-8 NO BOM
const manifestPath = path.join(stage, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const hadKey = 'key' in manifest;
delete manifest.key;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { encoding: 'utf8' });
console.log(`[pack-webstore] manifest 'key' field: ${hadKey ? 'stripped' : 'absent (ok)'}`);

// 5. Zip via JSZip — guarantees forward-slash entry names on every OS.
//    PowerShell's Compress-Archive emits backslashes inside the archive
//    on Windows, which violates the ZIP spec and fails AMO validation.
//    Chrome Web Store has historically been lenient, but no reason to
//    ship a non-conformant archive.
const outDir = path.join(repoRoot, 'store_packages');
fs.mkdirSync(outDir, { recursive: true });
const zipPath = path.join(outDir, `claude-voyager-${version}.zip`);
if (fs.existsSync(zipPath)) fs.rmSync(zipPath);

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
  fs.writeFileSync(zipPath, buf);

  // 6. Clean stage
  fs.rmSync(stage, { recursive: true, force: true });

  const sizeKb = Math.round(fs.statSync(zipPath).size / 1024);
  console.log(`[pack-webstore] ✓ ${path.relative(repoRoot, zipPath)} (${sizeKb} KB) — ready for the Chrome Web Store.`);
})().catch((err) => {
  console.error('[pack-webstore] zip failed:', err);
  process.exit(1);
});
