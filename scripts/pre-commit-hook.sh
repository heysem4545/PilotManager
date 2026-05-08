#!/bin/sh
# Auto-bump APP_VERSION when index.html is part of a commit.
# Installed into .git/hooks/pre-commit by scripts/install-hooks.js.

if git diff --cached --name-only | grep -q '^index\.html$'; then
  echo "→ index.html staged — bumping APP_VERSION"
  node scripts/bump-version.js || exit 1
  git add index.html
fi
