/**
 * One source, two hosts (contract C2): what keeps the Mac host's code out of
 * the cloud build, and the Mac build's composition. Pins:
 *   - agents/chat-agent reaches agents/local-agent only through lib/mac-slots.ts,
 *     whose stubs throw: no file the cloud imports names agents/local-agent, so
 *     nothing from it (a local model's provider included) reaches the Vercel
 *     bundle;
 *   - the cloud tree has none of the Mac-only slots (sandbox.ts, finish, the
 *     fence prompt), which would change the cloud's compiled manifest;
 *   - the Mac build's copy (scripts/local-agent/mac-body.sh stage_mac_body)
 *     replaces the slots with re-exports of the same names, swaps the channel,
 *     adds the Mac slots and leaves out the quick helpers and the usage meter.
 * The cloud's compiled manifest itself is compared by building it before and
 * after (an `eve build`, too heavy for this suite: see the PR).
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as slots from '../mac-slots'

const CHAT_AGENT = fileURLToPath(new URL('../..', import.meta.url))
const REPO = join(CHAT_AGENT, '..', '..')

/** The names a module's source exports (functions, consts and re-export lists). */
function exportedNames(source: string): string[] {
  const names = new Set<string>()
  for (const m of source.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)) names.add(m[1])
  for (const m of source.matchAll(/^export \{([^}]+)\} from/gm)) for (const n of m[1].split(',')) names.add(n.trim())
  return [...names].sort()
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) out.push(p)
  }
  return out
}

describe('the cloud tree', () => {
  it('reaches agents/local-agent only through the slot stubs, which throw', () => {
    // Any static import/export (multi-line too), side-effect import, dynamic import() or require()
    // of agents/local-agent, quoted or a template literal, a file or the folder itself.
    const IMPORTS_LOCAL_AGENT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"`][^'"`]*\blocal-agent(?:\/|['"`])/
    const importers = sourceFiles(CHAT_AGENT).filter((f) => IMPORTS_LOCAL_AGENT.test(readFileSync(f, 'utf8')))
    expect(importers.map((f) => relative(CHAT_AGENT, f))).toEqual([])
    for (const sample of [
      "import '../../local-agent/x.js'",
      'const m = await import(`../../local-agent/lib/model.js`)',
      "require('../../local-agent')",
      "export { a } from\n  '../../local-agent/lib/model.js'",
    ]) expect(IMPORTS_LOCAL_AGENT.test(sample), sample).toBe(true)
    for (const [name, fn] of Object.entries(slots)) {
      expect(() => (fn as (...a: unknown[]) => unknown)(), name).toThrow(/Mac body only/)
    }
  })

  it('bundles without reaching agents/local-agent (esbuild’s import graph of every source file)', async () => {
    const { build } = await import('esbuild')
    const result = await build({
      entryPoints: sourceFiles(CHAT_AGENT),
      bundle: true,
      write: false,
      metafile: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      outdir: join(tmpdir(), 'chat-agent-graph'),
      logLevel: 'silent',
    })
    const inputs = Object.keys(result.metafile!.inputs)
    expect(inputs.filter((i) => /(?:^|\/)agents\/local-agent\//.test(i))).toEqual([])
    // The graph is the real one: it reaches the slot stub.
    expect(inputs.some((i) => i.endsWith('agents/chat-agent/lib/mac-slots.ts'))).toBe(true)
  })

  it('has none of the Mac host’s own slots', () => {
    for (const rel of ['sandbox.ts', 'tools/finish.ts', 'tools/request_folder_access.ts']) expect(existsSync(join(CHAT_AGENT, rel)), rel).toBe(false)
  })
})

describe.runIf(process.platform === 'darwin')('the Mac build’s copy (mac-body.sh stage_mac_body)', () => {
  it('re-exports the slots by the same names, swaps the channel, adds the Mac slots, leaves out the cloud’s', () => {
    const stage = mkdtempSync(join(tmpdir(), 'mac-body-stage-'))
    try {
      execFileSync('/bin/bash', ['-c', `set -euo pipefail; . scripts/local-agent/mac-body.sh; stage_mac_body "$1" "$2"`, 'stage', REPO, stage], { cwd: REPO })
      const body = join(stage, 'agents', 'chat-agent')
      const generated = readFileSync(join(body, 'lib', 'mac-slots.ts'), 'utf8')
      expect(exportedNames(generated)).toEqual(exportedNames(readFileSync(join(CHAT_AGENT, 'lib', 'mac-slots.ts'), 'utf8')))
      expect(generated).toContain("from '../../local-agent/lib/model.js'")
      expect(readFileSync(join(body, 'channels', 'eve.ts'), 'utf8')).toContain("from '../../local-agent/channels/eve.js'")
      expect(readFileSync(join(body, 'sandbox.ts'), 'utf8')).toContain("export { default, environment } from '../local-agent/sandbox.js'")
      for (const tool of ['finish', 'request_folder_access']) {
        expect(readFileSync(join(body, 'tools', `${tool}.ts`), 'utf8')).toContain(`from '../../local-agent/tools/${tool}.js'`)
      }
      for (const rel of ['subagents', 'tools/helpers.ts', 'hooks/usage-meter.ts', '.eve', '.output']) expect(existsSync(join(body, rel)), rel).toBe(false)
      expect(existsSync(join(stage, 'agents', 'local-agent', 'lib', 'host-folder-sandbox.ts'))).toBe(true)
    } finally {
      rmSync(stage, { recursive: true, force: true })
    }
  })
})
