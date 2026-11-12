#!/usr/bin/env bash
# The Studio's product-component runner (runner.ts), built for the Mac body:
#
#   agents/local-agent/studio/build.sh <out-dir>
#     → <out-dir>/runner/runner.cjs                    the runner, one CommonJS file
#     → <out-dir>/runner/stage/                        the stage sources the product's own esbuild compiles with its React
#     → <out-dir>/runner/node_modules/playwright-core  beside it as its own package (it finds its files by __dirname)
#     → <out-dir>/studio.tgz                           all of runner/: the one file the Mac-only tool studio_product
#                                                      writes into the job's scratch dir and unpacks there, inside the fence
#
# Called by scripts/local-agent/mac-body.sh build_studio (dev into .output/studio, and the desktop's bundle).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
web="$(cd "$here/../../.." && pwd)"
out="${1:?usage: build.sh <out-dir>}"
runner="$out/runner"
rm -rf "$runner" "$out/studio.tgz"
mkdir -p "$runner/stage/shims" "$runner/node_modules/playwright-core"
"$web/node_modules/.bin/esbuild" "$here/runner.ts" --bundle --platform=node --format=cjs --target=node22 \
  --outfile="$runner/runner.cjs" --log-level=warning \
  --external:esbuild --external:playwright-core --external:chromium-bidi --external:electron --external:fsevents
cp "$here/stage/stage-runtime.tsx" "$here/stage/kit-script.ts" "$here/stage/kit-world.ts" "$runner/stage/"
cp "$here/stage/shims/"* "$runner/stage/shims/"
cp -R "$web/node_modules/playwright-core/"{package.json,index.js,index.mjs,browsers.json,LICENSE,NOTICE,ThirdPartyNotices.txt,lib} "$runner/node_modules/playwright-core/"
COPYFILE_DISABLE=1 tar -czf "$out/studio.tgz" -C "$out" runner
