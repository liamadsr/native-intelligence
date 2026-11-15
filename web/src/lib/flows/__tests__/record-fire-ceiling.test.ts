/**
 * A record_created fire can always read the row that started it (forms
 * phase 2): the read-only table tools join the run's ceiling whatever the
 * skill's categories, in report and act mode, and nothing else changes. The
 * fact rides the signed run token, so the routes that rebuild the ceiling
 * (the spec rebuild, the tool route) reach the same answer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getMutatingToolNames, getToolSideEffect } from '@/lib/ai/tool-registry'
import { RECORD_READ_TOOLS, computeSkillCeiling, recordReadRefusal, recordTableOf } from '../run-skill'
import { parseSkillRunFacts } from '../skill-run-session'
import { mintRunToken, verifyRunToken } from '../skill-run-token'

type AgentConfig = Parameters<typeof computeSkillCeiling>[0]
const scoped: AgentConfig = { enabled_tools: ['emails', 'contacts', 'calendar'] }

describe('the ceiling of a run a new row started', () => {
  it('adds exactly the read-only table tools to a skill scoped away from tables', () => {
    for (const mode of ['report', 'act'] as const) {
      const without = computeSkillCeiling(scoped, mode, false)!
      const withRow = computeSkillCeiling(scoped, mode, false, true)!
      for (const name of RECORD_READ_TOOLS) {
        expect(without.has(name), `${mode} ${name}`).toBe(false)
        expect(withRow.has(name), `${mode} ${name}`).toBe(true)
      }
      expect([...withRow].filter((n) => !without.has(n)).sort()).toEqual([...RECORD_READ_TOOLS].sort())
      // Nothing that writes a table comes with them.
      for (const name of ['write_rows', 'archive_rows', 'create_table', 'update_table_columns', 'create_form', 'update_form']) expect(withRow.has(name), name).toBe(false)
    }
  })

  it('the tools it adds are reads', () => {
    const mutating = getMutatingToolNames()
    for (const name of RECORD_READ_TOOLS) {
      expect(getToolSideEffect(name), name).toBe('read')
      expect(mutating.has(name), name).toBe(false)
    }
  })

  it('leaves every other run as it was, and adds nothing to a skill that already reads tables', () => {
    expect(computeSkillCeiling(scoped, 'report', false, false)).toEqual(computeSkillCeiling(scoped, 'report', false))
    expect(computeSkillCeiling(scoped, 'report', true, false)).toEqual(computeSkillCeiling(scoped, 'report', true))
    const withTables: AgentConfig = { enabled_tools: ['tables'] }
    expect(computeSkillCeiling(withTables, 'report', false, true)).toEqual(computeSkillCeiling(withTables, 'report', false))
  })
})

describe('the forced reads reach one table', () => {
  const TABLE = '33333333-3333-4333-8333-333333333333'
  const OTHER = '44444444-4444-4444-8444-444444444444'
  const own = computeSkillCeiling(scoped, 'report', false)
  const ask = (toolName: string, input: unknown, ownCeiling: Set<string> | null = own, recordTableId: string | null = TABLE) => recordReadRefusal({ toolName, input, recordTableId, ownCeiling })

  it('the table that fired the run, by its id; never another, never by name', () => {
    expect(ask('query_rows', { table: TABLE, row_ids: ['r1'] })).toBeNull()
    expect(ask('get_table', { table: ` ${TABLE.toUpperCase()} ` })).toBeNull()
    for (const input of [{ table: OTHER }, { table: 'Salaries' }, { table: 'Website leads' }, {}, null, { table: 7 }]) {
      expect(ask('query_rows', input), JSON.stringify(input)).toContain(TABLE)
      expect(ask('get_table', input), JSON.stringify(input)).toContain('reads only the table')
    }
  })

  it("a skill that reads tables on its own reads as it always did, as does every other tool and every other run", () => {
    const withTables = computeSkillCeiling({ enabled_tools: ['tables'] }, 'report', false)
    expect(ask('query_rows', { table: OTHER }, withTables)).toBeNull()
    // An unrestricted skill (no ceiling at all).
    expect(ask('query_rows', { table: OTHER }, null)).toBeNull()
    expect(ask('list_emails', { table: OTHER })).toBeNull()
    expect(ask('query_rows', { table: OTHER }, own, null)).toBeNull()
  })

  it('the fire names its table only when it is a row fire with a real id', () => {
    expect(recordTableOf({ type: 'record_created', table_id: TABLE.toUpperCase() })).toBe(TABLE)
    expect(recordTableOf({ type: 'record_created', table_id: 'Leads' })).toBeNull()
    expect(recordTableOf({ type: 'record_created' })).toBeNull()
    expect(recordTableOf({ type: 'document_created', table_id: TABLE })).toBeNull()
    expect(recordTableOf(null)).toBeNull()
  })
})

describe('the run token', () => {
  const base = { workspaceId: 'ws-1', runAsUserId: 'u-1', skillId: 's-1', mode: 'report' as const, hasCapture: false, outputContract: 'prose' as const, model: 'm' }
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.RUN_SKILL_INTERNAL_SECRET
    process.env.RUN_SKILL_INTERNAL_SECRET = 'test-secret-for-run-tokens'
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.RUN_SKILL_INTERNAL_SECRET
    else process.env.RUN_SKILL_INTERNAL_SECRET = saved
  })

  it('carries the table signed, and a token without it is not a row fire', () => {
    expect(verifyRunToken(mintRunToken({ ...base, recordTableId: '33333333-3333-4333-8333-333333333333' }))?.recordTableId).toBe('33333333-3333-4333-8333-333333333333')
    expect(verifyRunToken(mintRunToken(base))?.recordTableId).toBeUndefined()
  })

  it("can't be added by editing the token: the signature no longer matches", () => {
    const token = mintRunToken(base)
    const [payload, sig] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), recordTableId: '44444444-4444-4444-8444-444444444444' }), 'utf8').toString('base64url')
    expect(verifyRunToken(`${forged}.${sig}`)).toBeNull()
  })
})

describe('a parked run and its follow-up chat', () => {
  const TABLE = '33333333-3333-4333-8333-333333333333'
  const facts = { skillId: 's-1', mode: 'report', outputContract: 'prose', model: 'm', runAsUserId: 'u-1', hasCapture: false }

  it("keeps the table with the run's facts, so the chat turn shadows the run's forced reads", () => {
    expect(parseSkillRunFacts({ ...facts, recordTableId: TABLE })?.recordTableId).toBe(TABLE)
    // A row stored before this, or a malformed one: not a row fire.
    expect(parseSkillRunFacts(facts)?.recordTableId).toBeUndefined()
    expect(parseSkillRunFacts({ ...facts, recordTableId: 'Leads' })?.recordTableId).toBeUndefined()
  })
})
