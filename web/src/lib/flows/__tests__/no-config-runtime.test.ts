/**
 * Migration-adjacent guard (Runtime Controller W-C): the per-action
 * `config.runtime` key is REMOVED and migration 204 wiped surviving values. The
 * executor and the config validators must never read it again — a stray legacy
 * value on an old jsonb blob must be inert. This is a SOURCE assertion (cheap,
 * no runtime) so a future edit that reintroduces `config.runtime` fails loudly.
 *
 * WS-3a: the same holds for the SUBSTRATE. Every run is eve (runSpecViaEve →
 * runViaEve); the in-process gateway branch (runSpecViaGateway / generateText)
 * and its env switch (RUN_SKILL_EVE_RUNTIME, shouldUseEveRuntime) are deleted.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..')

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
}

describe('W-C: config.runtime is never read', () => {
  it('run-skill.ts (the executor) never references config.runtime', () => {
    const src = read('run-skill.ts')
    expect(src).not.toMatch(/config\.runtime/)
  })

  it('queries.ts (validators) never reads r.runtime / config.runtime', () => {
    const src = read('queries.ts')
    // The validators dropped runtime entirely — neither the incoming `r.runtime`
    // nor a stored `.runtime` read survives.
    expect(src).not.toMatch(/r\.runtime/)
    expect(src).not.toMatch(/\.config as RunSkillActionConfig\)\.runtime/)
  })

  it('RunSkillActionConfig has no `runtime` field in types.ts', () => {
    const src = read('types.ts')
    // The interface body between RunSkillActionConfig and the next interface must
    // not declare a `runtime?:` property.
    const start = src.indexOf('interface RunSkillActionConfig')
    expect(start).toBeGreaterThan(-1)
    const next = src.indexOf('interface RunAgentActionConfig', start)
    const body = src.slice(start, next)
    expect(body).not.toMatch(/^\s*runtime\??:/m)
  })

  it('migration 204 exists and strips the runtime key from flow.actions', () => {
    const mig = readFileSync(
      join(SRC, '../../../supabase/migrations/204_strip_flow_action_runtime.sql'),
      'utf8',
    )
    // The cleanup removes 'runtime' from each action's config jsonb.
    expect(mig).toMatch(/-\s*'runtime'/)
    expect(mig).toMatch(/update public\.flow/i)
  })
})

describe('WS-3a: the server runtime is eve, unconditionally', () => {
  const FLOW_FILES = [
    'run-skill.ts',
    'run-skill-eve.ts',
    'skill-run-token.ts',
    'skill-run-rebuild.ts',
    'types.ts',
  ]

  it('no flows source reads or names an eve-vs-gateway switch', () => {
    for (const f of FLOW_FILES) {
      const src = read(f)
      expect(src, f).not.toMatch(/RUN_SKILL_EVE_RUNTIME/)
      expect(src, f).not.toMatch(/shouldUseEveRuntime/)
    }
  })

  it('the executor has no in-process gateway branch', () => {
    const src = read('run-skill.ts')
    expect(src).not.toMatch(/runSpecViaGateway/)
    expect(src).not.toMatch(/\bgenerateText\b/)
    expect(src).not.toMatch(/from 'ai'/)
    expect(src).not.toMatch(/createVerdictTool/)
  })

  it('every run dispatches through runSpecViaEve → runViaEve', () => {
    const src = read('run-skill.ts')
    expect(src).toMatch(/import \{[^}]*\brunViaEve\b[^}]*\} from '\.\/run-skill-eve'/)
    expect(src).toMatch(/return await runSpecViaEve\(/)
  })

  it('the in-process submit_run_verdict tool is gone (verdict-schema.ts carries the contract)', () => {
    expect(() => read('verdict-tool.ts')).toThrow()
    expect(read('verdict-schema.ts')).toMatch(/export const verdictOutputSchema/)
  })
})
