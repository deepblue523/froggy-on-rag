#!/usr/bin/env node
/**
 * Remove dist/ before electron-builder. Windows often leaves dist/__msi-* locked
 * after a cancelled or overlapping build; retries help clear transient EBUSY.
 */
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(dist)) process.exit(0);

try {
  fs.rmSync(dist, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
} catch (e) {
  console.error(
    'Could not remove dist/. Close File Explorer windows on dist/, stop other electron-builder runs, then retry.\n',
    e.message,
  );
  process.exit(1);
}
