#!/usr/bin/env bash
#
# The leak check: run before a push (.githooks/pre-push) and on every push and pull
# request (.github/workflows/guard.yml).
#   1. gitleaks: anything shaped like a key. web/, desktop/ and ios/ each use their own
#      .gitleaks.toml (fake keys in tests are allowed there); the rest of the repo uses
#      gitleaks' defaults.
#   2. The private names list: real people, customers and partners that must never be
#      committed. The list itself isn't in the repo. DENYLIST_FILE points at a
#      maintainer's copy (default ~/.config/native-intelligence/denylist.txt); CI writes it
#      from the DENYLIST secret. Without it, this step is skipped and says so.
#
# It checks one commit's files exactly as committed, never the working tree, so
# untracked files, node_modules and local .env files don't count.
#
# Usage: .github/guard.sh [commit]   # default HEAD
# Needs gitleaks (brew install gitleaks).

set -eo pipefail

REV=${1:-HEAD}
ROOT=$(git rev-parse --show-toplevel)
DENYLIST_FILE=${DENYLIST_FILE:-"$HOME/.config/native-intelligence/denylist.txt"}
command -v gitleaks >/dev/null || { echo "guard: missing gitleaks (brew install gitleaks)" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# The commit's files, through a scratch index: every tracked file, whatever
# .gitattributes says about export-ignore.
GIT_INDEX_FILE="$work/index" git -C "$ROOT" read-tree "$REV"
GIT_INDEX_FILE="$work/index" git -C "$ROOT" checkout-index -a --prefix="$work/tree/"
cd "$work/tree"
failed=""

echo "== gitleaks"
for dir in web desktop ios; do
  [ -d "$dir" ] || continue
  if [ -f "$dir/.gitleaks.toml" ]; then
    (cd "$dir" && gitleaks dir --no-banner --redact --config .gitleaks.toml .) || failed="$failed gitleaks-$dir"
  else
    (cd "$dir" && gitleaks dir --no-banner --redact .) || failed="$failed gitleaks-$dir"
  fi
done
cat > "$work/top.toml" <<'TOML'
[extend]
useDefault = true

[[allowlists]]
paths = ['''^(web|desktop|ios)/''']
TOML
gitleaks dir --no-banner --redact --config "$work/top.toml" . || failed="$failed gitleaks-top"

echo
echo "== the private names list"
if [ -f "$DENYLIST_FILE" ]; then
  grep -vE '^[[:space:]]*(#|$)' "$DENYLIST_FILE" > "$work/patterns" || true
  # git grep exits 0 on a match, 1 on none, and anything else when it couldn't run.
  names() { # <label> <folder> <git grep args>...
    local label=$1 dir=$2 found=0
    shift 2
    git -C "$dir" grep --no-index -niP -f "$work/patterns" "$@" || found=$?
    case $found in
      0) failed="$failed $label" ;;
      1) echo "none" ;;
      *) failed="$failed $label-error" ;;
    esac
  }
  # Binary files too. The vocabulary lexicons are dictionaries: a surname there is just a word.
  names names "$work/tree" -- . ':(exclude)web/src/lib/vocabulary/lexicon-*.ts'
  find . > "$work/paths"
  names names-in-paths "$work" -- paths
else
  echo "skipped: no list at $DENYLIST_FILE"
fi

echo
if [ -n "$failed" ]; then
  echo "NOT CLEAN:$failed" >&2
  exit 1
fi
echo "Clean."
