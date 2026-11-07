#!/usr/bin/env bash
#
# Vercel's Ignored Build Step (vercel.json `ignoreCommand`). Exit 0 skips the
# build; any other exit builds it.
#
#   1. Every branch but main is skipped: preview builds are off. vercel.json's
#      git.deploymentEnabled already stops branch pushes from creating a
#      deployment at all; this catches the rest, such as a CLI deploy from a
#      branch.
#   2. On main, a commit that cannot change the deployment is skipped: one that
#      only touches internal docs, root-level markdown, editor/CI/E2E tooling
#      or unit tests (the suite runs locally before merge). Every main build
#      bills the build machine for the whole suite, `next build` and the cache.
#
# The diff runs against VERCEL_GIT_PREVIOUS_SHA, main's last SUCCESSFUL
# deployment, so a skipped or failed commit's changes still count towards the
# next build. Anything unclear builds: a manual deploy (no branch), main's first
# deploy, a redeploy of the live commit, or a previous deploy older than the
# shallow clone (depth 10) that `git diff` cannot reach.

if [ -n "$VERCEL_GIT_COMMIT_REF" ] && [ "$VERCEL_GIT_COMMIT_REF" != "main" ]; then
  exit 0
fi

prev="$VERCEL_GIT_PREVIOUS_SHA"
head="${VERCEL_GIT_COMMIT_SHA:-HEAD}"
if [ -z "$VERCEL_GIT_COMMIT_REF" ] || [ -z "$prev" ] || [ "$prev" = "$head" ]; then
  exit 1
fi

# --no-renames: a rename lists its old path too, so moving a deployed file
# into docs/ or a __tests__/ folder still builds.
# --relative: only what changed inside the folder Vercel builds from (the
# project's Root Directory, where this runs), with paths relative to it. In the
# one-repo layout (web/ beside desktop/ and ios/), a commit that only touches
# the desktop or iPhone app, or the repo's top-level files, changes nothing here.
changed=$(git diff --relative --no-renames --name-only "$prev" "$head" 2>/dev/null) || exit 1
if [ -z "$changed" ]; then
  echo "Nothing in this folder changed since ${prev:0:8}: skipping the build."
  exit 0
fi

# content/docs (the docs site) and agents/*/instructions.md DO deploy: only
# the top-level docs/ folder and markdown at the repo root are skipped.
deployable=$(printf '%s\n' "$changed" \
  | grep -vE '^(docs/|\.claude/|\.github/|\.design-sync/|e2e/|[^/]+\.md$|playwright\.config\.ts$)' \
  | grep -vE '(^|/)__tests__/|\.test\.tsx?$')

if [ -z "$deployable" ]; then
  echo "Only docs, tooling or tests changed since ${prev:0:8}: skipping the build."
  exit 0
fi
exit 1
