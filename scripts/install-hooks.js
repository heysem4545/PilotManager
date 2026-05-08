#!/usr/bin/env node
// Installs the tracked git hooks into .git/hooks/. Runs automatically on
// `npm install` via the `prepare` script.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const hooksDir = path.join(repoRoot, '.git', 'hooks');

if (!fs.existsSync(hooksDir)) {
  // Not a git checkout (e.g., installed as a dependency) — nothing to do.
  process.exit(0);
}

const src = path.join(__dirname, 'pre-commit-hook.sh');
const dst = path.join(hooksDir, 'pre-commit');

fs.copyFileSync(src, dst);
fs.chmodSync(dst, 0o755);
console.log('✓ Installed pre-commit hook → .git/hooks/pre-commit');
