import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The image holds only what the Dockerfile copies, and Docker is sent only what
// Dockerfile.dockerignore lets through. The worker loads the engine and the contracts from
// web/ by path, so the day one of them imports a file the Dockerfile does not name, the
// worker in the image dies at start with MODULE_NOT_FOUND, and nothing run on a checkout
// sees it. The first image ever built did exactly that (four contract files were missing).
// This walks every relative import from the worker's code and from the engine's two entry
// files, and holds each file reached against both lists.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CODE = /\.(ts|tsx|mts|js|mjs)$/
const SPECIFIER = /(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g

function codeUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) codeUnder(path, out)
    else if (CODE.test(entry.name)) out.push(path)
  }
  return out
}

function fileFor(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier)
  const tries = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
  return tries.find((path) => existsSync(path) && statSync(path).isFile()) ?? null
}

/** Every file reached by a relative import, as paths from the repository's root. */
function reached(starts: string[]): Map<string, string> {
  const seen = new Map<string, string>()
  const queue: Array<[string, string]> = starts.map((file) => [file, '(a starting file)'])
  for (let next = queue.pop(); next; next = queue.pop()) {
    const [file, importer] = next
    const name = relative(ROOT, file)
    if (seen.has(name)) continue
    seen.set(name, importer)
    if (!CODE.test(file)) continue
    for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2] ?? match[3]
      if (!specifier?.startsWith('.')) continue
      const to = fileFor(file, specifier)
      if (to) queue.push([to, name])
    }
  }
  return seen
}

/** A Docker path pattern (a file, a folder, or one with `*`) as a test on a path from the root. */
function pattern(source: string): (path: string) => boolean {
  const clean = source.replace(/\/+$/, '')
  if (clean.includes('*')) {
    const expression = new RegExp(`^${clean.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)
    return (path) => expression.test(path)
  }
  return (path) => path === clean || path.startsWith(`${clean}/`)
}

function copiedByDockerfile(): Array<(path: string) => boolean> {
  return readFileSync(join(ROOT, 'studio-worker/Dockerfile'), 'utf8')
    .split('\n')
    .filter((line) => /^COPY\s/.test(line) && !/\s--from=/.test(line))
    .flatMap((line) => line.trim().split(/\s+/).slice(1, -1))
    .map(pattern)
}

function sentToDocker(): Array<(path: string) => boolean> {
  return readFileSync(join(ROOT, 'studio-worker/Dockerfile.dockerignore'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('!'))
    .map((line) => pattern(line.slice(1).trim()))
}

test('the image holds every file the worker and the engine reach', () => {
  const engine = join(ROOT, 'web/src/lib/studio/engine')
  const files = reached([...codeUnder(join(ROOT, 'studio-worker/src')), join(engine, 'remotion.tsx'), join(engine, 'scene-frame/runtime.tsx')])
  // The walk found the files the worker is known to load from web/, so an empty answer below means "all there", not "nothing read".
  assert.ok(files.has('web/src/lib/studio/server/job-contract.ts'))
  assert.ok(files.has('web/src/lib/studio/server/sound-contract.ts'))
  assert.ok(files.has('web/src/lib/studio/engine/composition.tsx'))

  const copied = copiedByDockerfile()
  const sent = sentToDocker()
  const notCopied = [...files].filter(([path]) => !copied.some((holds) => holds(path))).map(([path, importer]) => `${path} (imported by ${importer})`)
  const notSent = [...files].filter(([path]) => !sent.some((holds) => holds(path))).map(([path, importer]) => `${path} (imported by ${importer})`)
  assert.deepEqual(notCopied, [], 'the Dockerfile copies none of these: add a COPY line')
  assert.deepEqual(notSent, [], 'Dockerfile.dockerignore keeps these from Docker: add a ! line')
})

test('a pattern holds a file, what is under a folder, and one star within a folder', () => {
  assert.ok(pattern('web/src/lib/studio/engine')('web/src/lib/studio/engine/scene-frame/build.ts'))
  assert.ok(!pattern('web/src/lib/studio/engine')('web/src/lib/studio/engines/x.ts'))
  assert.ok(pattern('web/src/lib/studio/server/*-contract.ts')('web/src/lib/studio/server/sound-contract.ts'))
  assert.ok(!pattern('web/src/lib/studio/server/*-contract.ts')('web/src/lib/studio/server/jobs.ts'))
  assert.ok(!pattern('web/src/lib/studio/server/*-contract.ts')('web/src/lib/studio/server/deep/x-contract.ts'))
  assert.ok(pattern('studio-worker/tsconfig.json')('studio-worker/tsconfig.json'))
})
