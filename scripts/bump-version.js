#!/usr/bin/env node

/**
 * Bump package.json and package-lock.json (same as `npm version`) without git commit/tag.
 *
 * Usage:
 *   node scripts/bump-version.js patch   (1.0.0 -> 1.0.1)
 *   node scripts/bump-version.js minor   (1.0.0 -> 1.1.0)
 *   node scripts/bump-version.js major   (1.0.0 -> 2.0.0)
 *   node scripts/bump-version.js         (defaults to patch)
 */

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

const arg = process.argv[2];
const bumpType = ['major', 'minor', 'patch'].includes(arg) ? arg : arg ? null : 'patch';

if (arg && !bumpType) {
  console.error(`Invalid bump "${arg}". Use patch, minor, or major.`);
  process.exit(1);
}

const projectRoot = path.join(__dirname, '..');
const npmArgs = ['version', bumpType, '--no-git-tag-version'];

if (process.platform === 'win32') {
  const r = spawnSync('cmd.exe', ['/d', '/c', 'npm', ...npmArgs], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
} else {
  try {
    execFileSync('npm', npmArgs, { cwd: projectRoot, stdio: 'inherit' });
  } catch (e) {
    process.exit(typeof e.status === 'number' ? e.status : 1);
  }
}
