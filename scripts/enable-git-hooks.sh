#!/bin/sh
# Turns on the tracked hooks in .githooks (SHOP-06).
#   pnpm hooks:enable
# core.hooksPath lives in the repo's shared git config, so this applies to every
# worktree of this clone at once, including any other session committing now.
# To turn it off again: git config --unset core.hooksPath
cd "$(git rev-parse --show-toplevel)" || exit 1
git config core.hooksPath .githooks
echo "Hooks on: each commit now runs .githooks/pre-commit."
