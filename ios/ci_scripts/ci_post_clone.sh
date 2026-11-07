#!/bin/sh
# Xcode Cloud runs this after it clones the repo. The public repo leaves the Apple team
# blank (DEVELOPMENT_TEAM = "" in Dial8.xcodeproj and project.yml), so the build gets it
# here, from the workflow's secret environment variable DEVELOPMENT_TEAM_ID (Xcode Cloud:
# the workflow's Environment section). A project that already names a team is left alone.
set -eu

project="$(cd "$(dirname "$0")/.." && pwd)/Dial8.xcodeproj/project.pbxproj"
if ! grep -q -E '(DEVELOPMENT_TEAM|DevelopmentTeam) = "";' "$project"; then
  echo "ci_post_clone: the project already names its team"
  exit 0
fi
team="${DEVELOPMENT_TEAM_ID:-}"
if ! printf '%s' "$team" | grep -q -E '^[A-Z0-9]{10}$'; then
  echo "ci_post_clone: set DEVELOPMENT_TEAM_ID (a 10-character Apple team ID) in the workflow's environment" >&2
  exit 1
fi
sed -i '' -E "s/(DEVELOPMENT_TEAM|DevelopmentTeam) = \"\";/\1 = $team;/g" "$project"
echo "ci_post_clone: signing with team from DEVELOPMENT_TEAM_ID"
