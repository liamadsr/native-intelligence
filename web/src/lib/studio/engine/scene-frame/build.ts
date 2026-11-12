// Building the code scene frame's runtime (runtime.tsx: React, Remotion, the kit) into one browser script. The app
// serves it as /studio-scene/frame-runtime.js (web/scripts/studio-scene-runtime.mjs runs this before `next dev` and
// `next build`), and the Studio worker writes it into its render bundle's public folder, so the editor's preview and
// the export run the same frame. Node only, and it imports nothing of the app: the caller hands in its own esbuild
// (the worker's image has no esbuild under web/), so both run this file as it is.
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Where the runtime is served from, in the app's public folder and in a render bundle's. */
export const RUNTIME_PATH = 'studio-scene/frame-runtime.js'

/** The parts of esbuild's API used here. */
type Esbuild = {
  build(options: Record<string, unknown>): Promise<{ outputFiles?: { text: string }[]; errors: unknown[] }>
}

/** The runtime's entry inside the engine's folder (web/src/lib/studio/engine). */
export const runtimeEntry = (engineDir: string) => join(engineDir, 'scene-frame', 'runtime.tsx')

/**
 * Bundle the runtime from the engine at `engineDir` and write it to `outFile` (written beside it first, then moved,
 * so a reader never sees half a file). Answers its size in bytes.
 */
export async function buildSceneRuntime(esbuild: Esbuild, engineDir: string, outFile: string): Promise<number> {
  const result = await esbuild.build({
    entryPoints: [runtimeEntry(engineDir)],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    jsx: 'automatic',
    legalComments: 'eof',
    define: { 'process.env.NODE_ENV': '"production"' },
    // A `</script` inside the runtime would end the inline script the frame adds it as.
    supported: { 'inline-script': true },
    logLevel: 'silent',
    banner: { js: '// Native Intelligence Studio: the code scene frame runtime (React, Remotion, the scene kit).' },
  })
  const text = result.outputFiles?.[0]?.text
  if (!text) throw new Error('The scene runtime did not bundle')
  if (/<\/script/i.test(text)) throw new Error('The scene runtime contains </script and cannot run inline')
  await mkdir(dirname(outFile), { recursive: true })
  const partial = `${outFile}.${process.pid}.partial`
  await writeFile(partial, text)
  await rename(partial, outFile)
  return Buffer.byteLength(text)
}
