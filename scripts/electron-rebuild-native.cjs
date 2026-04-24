/**
 * Rebuild native addons against the same Electron version the app ships with.
 * Avoids ABI / "version" mismatches when node-abi or dependency resolution picks the wrong runtime.
 * Skips when `electron` is not installed (e.g. npm install --omit=dev for CLI-only use).
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const electronEntry = path.join(root, 'node_modules', 'electron', 'package.json');

if (!fs.existsSync(electronEntry)) {
  console.log(
    'postinstall: skipping electron native rebuild (electron not in node_modules; deps-only install is OK for CLI).'
  );
  process.exit(0);
}

const { version: electronVersion } = require(electronEntry);

const env = { ...process.env };
if (process.platform === 'win32' && !env.npm_config_msvs_version) {
  env.npm_config_msvs_version = '2022';
}

const args = [
  path.join(root, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js'),
  '-f',
  '-w',
  'better-sqlite3',
  '-w',
  'sharp',
  '-v',
  electronVersion
];

const r = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: 'inherit',
  env
});

process.exit(r.status === null ? 1 : r.status);
