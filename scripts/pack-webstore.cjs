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
 * Output: claude-voyager-<version>.zip in the repo root.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

// 5. Zip — use PowerShell's Compress-Archive on Windows, `zip` elsewhere
const zipPath = path.join(repoRoot, `claude-voyager-${version}.zip`);
if (fs.existsSync(zipPath)) fs.rmSync(zipPath);

const isWin = process.platform === 'win32';
let res;
if (isWin) {
  // Compress-Archive happily takes a wildcard path so we get the zip
  // CONTENTS (not a wrapping folder) — Web Store expects manifest.json
  // at the zip root.
  res = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipPath}' -Force`,
    ],
    { stdio: 'inherit' },
  );
} else {
  // `cd stage && zip -r ../claude-voyager-X.zip .` keeps manifest at root.
  res = spawnSync('zip', ['-r', zipPath, '.'], { stdio: 'inherit', cwd: stage });
}
if (res.status !== 0) {
  console.error(`[pack-webstore] zip failed (status ${res.status})`);
  process.exit(res.status ?? 1);
}

// 6. Clean stage
fs.rmSync(stage, { recursive: true, force: true });

const sizeKb = Math.round(fs.statSync(zipPath).size / 1024);
console.log(`[pack-webstore] ✓ ${path.basename(zipPath)} (${sizeKb} KB) — ready for the Chrome Web Store.`);
