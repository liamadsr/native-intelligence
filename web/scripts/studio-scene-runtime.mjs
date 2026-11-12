// The Studio's code scene frame runtime (src/lib/studio/engine/scene-frame/), served at
// /studio-scene/frame-runtime.js: React, Remotion and the scene kit in one script that a scene's locked frame runs.
// Runs before `next dev` and `next build`. Generated, not committed (.gitignore).
// Usage: node scripts/studio-scene-runtime.mjs [outFile]   (default public/studio-scene/frame-runtime.js)
import * as esbuild from 'esbuild'
import { resolve } from 'node:path'
import { buildSceneRuntime, RUNTIME_PATH } from '../src/lib/studio/engine/scene-frame/build.ts'

const out = resolve(process.argv[2] ?? `public/${RUNTIME_PATH}`)
const bytes = await buildSceneRuntime(esbuild, resolve('src/lib/studio/engine'), out)
console.log(`studio scene runtime: ${out} (${Math.round(bytes / 1024)} KB)`)
