#!/usr/bin/env node
// Bumps APP_VERSION in index.html.
// Format: YYYY-MM-DD-N. If today's date already has a build, increments N.
// Otherwise resets to today + N=1. Run before each deploy that needs to
// invalidate older client tabs.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(filePath, 'utf8');

const today = new Date();
const dateStr = today.getFullYear() + '-' +
  String(today.getMonth() + 1).padStart(2, '0') + '-' +
  String(today.getDate()).padStart(2, '0');

const versionRegex = /const APP_VERSION='([^']+)';/;
const match = html.match(versionRegex);
if (!match) {
  console.error('ERROR: Could not find APP_VERSION in index.html');
  process.exit(1);
}

const current = match[1];
const parts = current.match(/^(\d{4}-\d{2}-\d{2})(?:-(\d+))?$/);
const currentDate = parts ? parts[1] : null;
const currentNum = parts && parts[2] ? parseInt(parts[2], 10) : 0;
const newNum = currentDate === dateStr ? currentNum + 1 : 1;
const newVersion = `${dateStr}-${newNum}`;

const updated = html.replace(versionRegex, `const APP_VERSION='${newVersion}';`);
fs.writeFileSync(filePath, updated);
console.log(`APP_VERSION: ${current} → ${newVersion}`);
