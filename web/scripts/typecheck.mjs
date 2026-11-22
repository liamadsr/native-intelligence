#!/usr/bin/env node
/**
 * `npm run typecheck`: the whole of tsconfig.json, every file, in under 8 GB.
 *
 * One `tsc --noEmit` over this project needs more than 8 GB of heap (it ran out
 * at 8 GB in the cloud containers; about 10 GB at its end): the checker keeps
 * every type it builds for all ~8,600 files until it exits. Splitting the
 * project by its roots does not help (the tests alone reach 7,950 of those
 * files through their imports), and project references would need declaration
 * emit, which ~1,000 inferred types in the app cannot do (TS2742).
 *
 * So this runs the same program in a few processes, one after another (or
 * side by side with --jobs). Each parses and binds every file, as tsc does,
 * but checks only its share of them: the checker builds types lazily, so a
 * process holds the types its own files need, not everyone's. Every file is
 * checked by exactly one process, with the same compiler options, so the
 * errors are tsc's, printed tsc's way; only their order can differ.
 *
 *   node scripts/typecheck.mjs              # 4 shards, one at a time
 *   node scripts/typecheck.mjs --shards 2   # fewer, larger shards
 *   node scripts/typecheck.mjs --jobs 2     # two shards side by side (twice the memory)
 *   node scripts/typecheck.mjs -p tsconfig.build.json
 *
 * The program is tsconfig.json's own (its include and exclude), so an editor,
 * `tsc --noEmit` on a big machine and this agree on what is checked.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import ts from 'typescript'

const here = fileURLToPath(import.meta.url)
const root = path.resolve(path.dirname(here), '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}
const project = path.resolve(root, arg('-p', arg('--project', 'tsconfig.json')))
const shards = Math.max(1, Number(arg('--shards', '4')))
const jobs = Math.max(1, Math.min(shards, Number(arg('--jobs', '1'))))
const heapMb = Number(arg('--heap', '8192'))
const shard = arg('--shard', null)

/** The program tsc would build for this project (compiler options, files), without emit or build info. */
function createProgram() {
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => report([d]) }
  const config = ts.getParsedCommandLineOfConfigFile(project, { noEmit: true, incremental: false }, host)
  if (!config) process.exit(2)
  const options = { ...config.options, incremental: false, tsBuildInfoFile: undefined, noEmit: true }
  const program = ts.createProgram({ rootNames: config.fileNames, options, projectReferences: config.projectReferences, configFileParsingDiagnostics: config.errors })
  return { program, configErrors: config.errors }
}

/** The files tsc checks and reports on: the project's own, not a package's declarations (skipLibCheck). */
function ownFiles(program) {
  return program
    .getSourceFiles()
    .filter((f) => !program.isSourceFileFromExternalLibrary(f) && !program.isSourceFileDefaultLibrary(f))
    .sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0))
}

/**
 * Shard `index` of `count`: a run of neighbouring files (files in one folder
 * share most of their types), cut so each shard has about the same amount of
 * source text.
 */
function shardOf(files, index, count) {
  const total = files.reduce((s, f) => s + f.text.length, 0)
  const from = (total * index) / count
  const to = (total * (index + 1)) / count
  const out = []
  let at = 0
  for (const f of files) {
    const mid = at + f.text.length / 2
    if (mid >= from && mid < to) out.push(f)
    at += f.text.length
  }
  return out
}

const formatHost = {
  getCanonicalFileName: (f) => f,
  getCurrentDirectory: () => process.cwd(),
  getNewLine: () => ts.sys.newLine,
}

function report(diagnostics) {
  if (diagnostics.length === 0) return
  const pretty = process.stdout.isTTY && !process.env.NO_COLOR
  process.stdout.write(pretty ? ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost) : ts.formatDiagnostics(diagnostics, formatHost))
}

/** In a child: check one shard, print its errors, exit 1 when there are any. */
function runShard(index, count) {
  const { program, configErrors } = createProgram()
  const files = shardOf(ownFiles(program), index, count)
  const diagnostics = []
  if (index === 0) {
    diagnostics.push(...configErrors, ...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics())
  }
  for (const file of files) {
    diagnostics.push(...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file))
  }
  report(ts.sortAndDeduplicateDiagnostics(diagnostics))
  const errors = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error).length
  process.stderr.write(`typecheck: shard ${index + 1}/${count}: ${files.length} files, ${errors} error${errors === 1 ? '' : 's'}\n`)
  process.exit(errors > 0 ? 1 : 0)
}

/** In the parent: every shard, `jobs` at a time; the exit code is the worst of theirs. */
async function runAll() {
  const started = Date.now()
  // The docs pages import fumadocs' generated collections; without them they are errors that are not the code's.
  if (!ts.sys.fileExists(path.join(root, '.source', 'server.ts'))) {
    process.stderr.write('typecheck: .source/server.ts is missing (next dev and next build write it): run `npx fumadocs-mdx` first\n')
  }
  let next = 0
  let worst = 0
  const one = () =>
    new Promise((resolve) => {
      const index = next++
      const child = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, here, '-p', project, '--shard', `${index}/${shards}`], { stdio: 'inherit', cwd: process.cwd() })
      child.on('exit', (code, signal) => {
        if (signal || code === null) process.stderr.write(`typecheck: shard ${index + 1}/${shards} stopped (${signal ?? 'no exit code'})\n`)
        worst = Math.max(worst, code ?? 2, signal ? 2 : 0)
        resolve()
      })
    })
  const lane = async () => {
    while (next < shards) await one()
  }
  await Promise.all(Array.from({ length: jobs }, lane))
  process.stderr.write(`typecheck: ${worst === 0 ? 'no errors' : 'errors found'} (${shards} shards, ${Math.round((Date.now() - started) / 1000)}s)\n`)
  process.exit(worst)
}

if (shard) {
  const [index, count] = shard.split('/').map(Number)
  runShard(index, count)
} else {
  await runAll()
}
