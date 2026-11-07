// ONNX Runtime's wasm runtime for the voice-embedding worker
// (src/workers/voice-embedding-worker.ts), served from this origin at
// /ort/<version>/ instead of transformers.js's default, jsdelivr. Runs before
// `next dev` and `next build`. Generated, not committed (.gitignore).
// - From the onnxruntime-web that @huggingface/transformers resolves (the copy
//   the worker bundles), and only at the exact version transformers.js pins.
// - The files are the ones that copy's browser entry fetches, and the version
//   directory is the one it reports at runtime (env.versions.web), which is
//   what the worker puts in its path.
// Usage: node scripts/copy-ort-runtime.mjs [outDir]   (default public/ort)
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// Neither package exports its package.json: find each one's directory the way
// Node resolves a bare specifier, in the nearest node_modules up from `from`.
function packageDir(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dirname(dir) === dir) throw new Error(`${name} isn't installed (resolving from ${from})`)
  }
}
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

const transformersDir = packageDir('@huggingface/transformers', process.cwd())
const ortDir = packageDir('onnxruntime-web', transformersDir)
const pinned = readJson(join(transformersDir, 'package.json')).dependencies['onnxruntime-web']
const ort = readJson(join(ortDir, 'package.json'))
if (ort.version !== pinned) {
  throw new Error(`onnxruntime-web ${ort.version} is installed but @huggingface/transformers pins ${pinned}; reinstall`)
}

// The browser entry a bundler resolves for `import 'onnxruntime-web'`, and the
// runtime files it loads from wasmPaths.
const entryPath = ort.exports['.'].import.default
const entry = readFileSync(join(ortDir, entryPath), 'utf8')
if (!entry.includes(JSON.stringify(ort.version))) throw new Error(`${entryPath} doesn't report version ${ort.version}`)
const files = [...new Set(entry.match(/ort-wasm-simd-threaded[\w.]*?\.(?:mjs|wasm)/g))]
if (!files.length) throw new Error(`${entryPath} names no ort-wasm runtime files`)

const root = resolve(process.argv[2] ?? 'public/ort')
rmSync(root, { recursive: true, force: true })
const out = join(root, ort.version)
mkdirSync(out, { recursive: true })
// A copy-on-write clone where the filesystem has one (APFS), else a copy.
for (const file of files) copyFileSync(join(ortDir, 'dist', file), join(out, file), constants.COPYFILE_FICLONE)
console.log(`onnxruntime-web ${ort.version}: ${out}/{${files.join(',')}}`)
