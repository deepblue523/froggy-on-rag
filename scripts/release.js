#!/usr/bin/env node

/**
 * Full release: bump semver, commit, tag, Windows build (electron-builder → dist/), publish GitHub release artifacts, push.
 *
 * Windows installer is configured as MSI in package.json (not .exe); output still lands under dist/.
 *
 * Usage:
 *   node scripts/release.js [patch|minor|major] [options]
 *
 * Options:
 *   --dry-run          Print steps only
 *   --skip-push        Commit and tag locally; build & publish; do not git push
 *   --allow-dirty      Allow uncommitted changes before starting
 *   --with-source-dist After publish, run scripts/create-dist.js (source bundle next to installers in dist/)
 *
 * Auth: set GH_TOKEN or GITHUB_TOKEN for electron-builder GitHub publish (see package.json build.publish).
 */

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');

function parseArgs(argv) {
  const flags = new Set();
  const positional = [];
  for (const a of argv) {
    if (a.startsWith('--')) flags.add(a);
    else positional.push(a);
  }
  return { flags, positional };
}

function run(cmd, args, { dryRun, label } = {}) {
  const line = [cmd, ...args].join(' ');
  if (label) console.log(`\n→ ${label}`);
  console.log(`  ${line}`);
  if (dryRun) return { status: 0 };
  const r = spawnSync(cmd, args, {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (r.error) {
    console.error(r.error);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
  return r;
}

function npm(args, opts) {
  const { dryRun, label } = opts || {};
  const line = ['npm', ...args].join(' ');
  if (label) console.log(`\n→ ${label}`);
  console.log(`  ${line}`);
  if (dryRun) return;
  if (process.platform === 'win32') {
    const r = spawnSync('cmd.exe', ['/d', '/c', 'npm', ...args], {
      cwd: projectRoot,
      stdio: 'inherit',
    });
    if (r.status !== 0) process.exit(r.status ?? 1);
  } else {
    try {
      execFileSync('npm', args, { cwd: projectRoot, stdio: 'inherit' });
    } catch (e) {
      process.exit(typeof e.status === 'number' ? e.status : 1);
    }
  }
}

function readVersion() {
  const p = path.join(projectRoot, 'package.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')).version;
}

function peekNextVersion(kind) {
  const v = readVersion();
  const parts = v.split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`Invalid semver in package.json: ${v}`);
  }
  switch (kind) {
    case 'major':
      return `${parts[0] + 1}.0.0`;
    case 'minor':
      return `${parts[0]}.${parts[1] + 1}.0`;
    case 'patch':
    default:
      return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }
}

function isGitClean() {
  const r = spawnSync('git', ['status', '--porcelain'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error('git status failed. Is this a git repository?');
    process.exit(1);
  }
  return !r.stdout.trim();
}

function tagExists(tag) {
  const r = spawnSync('git', ['rev-parse', tag], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  return r.status === 0;
}

function hasGhToken() {
  return Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const bumpKind = ['major', 'minor', 'patch'].includes(positional[0])
  ? positional[0]
  : positional[0]
    ? (console.error(`Unknown bump "${positional[0]}". Use patch, minor, or major.`), process.exit(1))
    : 'patch';

const dryRun = flags.has('--dry-run');
const skipPush = flags.has('--skip-push');
const allowDirty = flags.has('--allow-dirty');
const withSourceDist = flags.has('--with-source-dist');

if (!dryRun && !hasGhToken()) {
  console.error(
    'Missing GH_TOKEN or GITHUB_TOKEN. electron-builder needs this to create the GitHub release and upload artifacts.',
  );
  process.exit(1);
}

if (!allowDirty && !isGitClean()) {
  console.error(
    'Working tree is not clean. Commit or stash changes, or pass --allow-dirty (not recommended for releases).',
  );
  process.exit(1);
}

console.log(`Release (${bumpKind})${dryRun ? ' [dry-run]' : ''}`);

npm(['version', bumpKind, '--no-git-tag-version'], { dryRun, label: `Bump ${bumpKind} version` });

const version = dryRun ? peekNextVersion(bumpKind) : readVersion();
const tag = `v${version}`;

if (tagExists(tag)) {
  console.error(`Tag ${tag} already exists. Aborting.`);
  process.exit(1);
}

run('git', ['add', 'package.json', 'package-lock.json'], { dryRun, label: 'Stage version files' });
run('git', ['commit', '-m', `chore: release ${tag}`], { dryRun, label: 'Commit' });
run('git', ['tag', tag], { dryRun, label: 'Tag' });

npm(['run', 'build:publish'], { dryRun, label: 'Build Windows installer and publish to GitHub' });

if (withSourceDist) {
  run(process.execPath, [path.join(projectRoot, 'scripts', 'create-dist.js')], {
    dryRun,
    label: 'Create source distribution under dist/',
  });
}

if (!skipPush) {
  const branchR = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  const branch = (branchR.stdout || 'main').trim();
  run('git', ['push', 'origin', branch], { dryRun, label: 'Push branch' });
  run('git', ['push', 'origin', tag], { dryRun, label: 'Push tag' });
} else {
  console.log('\n(skip-push: run `git push origin <branch>` and `git push origin ' + tag + '` when ready)');
}

console.log(`\nDone${dryRun ? ' (dry-run)' : ''}. Version ${version}, tag ${tag}`);
