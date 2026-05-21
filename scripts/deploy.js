#!/usr/bin/env node
// One-command deploy:
//   1. Stage tracked changes (does not add new untracked files).
//   2. Commit with the message you pass — this fires the pre-commit hook
//      which bumps APP_VERSION if index.html is in the commit.
//   3. git push origin main.
//   4. If firestore.rules was in the commit, also run firebase deploy
//      --only firestore:rules.
//
// Usage:  npm run deploy -- "Your commit message"

const { execSync } = require('child_process');

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}
function out(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

const message = process.argv.slice(2).join(' ').trim();
if (!message) {
  console.error('Usage: npm run deploy -- "your commit message"');
  process.exit(1);
}

const dirty = out('git status --porcelain');
if (dirty) {
  run('git add -u');
  // Need to escape the message for the shell.
  run(`git commit -m ${JSON.stringify(message)}`);
} else {
  console.log('No tracked changes — pushing any existing commits.');
}

run('git push origin main');

// If the most recent commit touched firestore.rules or storage.rules, deploy them.
const lastFiles = out('git log -1 --name-only --format=').split('\n').filter(Boolean);
if (lastFiles.includes('firestore.rules')) {
  console.log('→ firestore.rules changed — deploying rules');
  run('firebase deploy --only firestore:rules');
}
if (lastFiles.includes('storage.rules')) {
  console.log('→ storage.rules changed — deploying rules');
  run('firebase deploy --only storage');
}

console.log('✓ Deploy complete');
