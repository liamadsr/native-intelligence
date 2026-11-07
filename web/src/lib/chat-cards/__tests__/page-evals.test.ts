/**
 * Evals as a card: on unless the workspace switched Evals off (as on the nav);
 * the suites, a suite's cases (a teammate's private case left out, as under
 * RLS) and runs.
 */
import { describe, expect, it } from 'vitest'
import { normalizePageInput } from '../page-validate'
import { buildCardContextEntry, parseCardContext, renderCardsSection } from '../context'
import { ID, allText, pageTools, seededWorkspace } from './page-fixtures'

describe('evals: the spec', () => {
  it("puts a suite's tabs inside a suite, naming the fix", () => {
    expect(normalizePageInput({ kind: 'evals', title: 'E', tab: 'runs' })).toEqual({
      ok: false,
      error: "tab: 'runs' is inside an eval suite. Give target, the suite's name or id, or leave tab out for the list of suites",
    })
    expect(normalizePageInput({ kind: 'evals', title: 'E', tab: 'nope' })).toEqual({
      ok: false,
      error: 'tab: evals has the tabs overview, cases, runs. Use one of them, or leave tab out for overview',
    })
    expect(normalizePageInput({ kind: 'evals', title: 'E', target: 'Triage', tab: 'Run' })).toMatchObject({ ok: true, value: { tab: 'runs' } })
  })
})

describe('evals: the gate', () => {
  it('is off where the workspace switched Evals off', async () => {
    const out = await pageTools(seededWorkspace({ evals: 'off' })).show({ kind: 'evals', title: 'Evals' })
    expect(out.success).toBe(false)
    expect(out.error).toContain('Evals is off in this workspace')
  })

  it('read_card refuses too, once Evals is off', async () => {
    const parsed = parseCardContext([buildCardContextEntry({ n: 1, id: 'c', spec: { kind: 'evals', title: 'Evals' } })])
    const read = await pageTools(seededWorkspace({ evals: 'off' }), parsed).readCard({ card: 1 })
    expect(read).toMatchObject({ success: false, code: 'PAGE_OFF' })
  })
})

describe('evals: show and read_card', () => {
  /** No overrides: Evals is on, like every feature. */
  const on = () => seededWorkspace()

  it('lists the suites', async () => {
    const out = await pageTools(on()).show({ kind: 'evals', title: 'Evals' })
    expect(out).toMatchObject({ success: true, count: 1, items: [{ id: ID.suite, title: 'Triage suite' }] })
  })

  it("opens a suite on its cases, a teammate's private case left out and the person's own kept", async () => {
    const out = await pageTools(on()).show({ kind: 'evals', title: 'Triage', target: 'triage suite', tab: 'cases' })
    expect(out.card).toEqual({ kind: 'evals', title: 'Triage', target: { type: 'eval_suite', id: ID.suite, label: 'Triage suite' }, tab: 'cases' })
    expect((out.items as Array<{ title: string }>).map((i) => i.title).sort()).toEqual(['My private case', 'Shared case'])
    expect(out.count).toBe(2)
    expect(allText(out)).not.toContain('Kenan private case')
  })

  it('reads the runs tab the person switched to, and says so', async () => {
    const entry = buildCardContextEntry({
      n: 4,
      id: 'c',
      spec: { kind: 'evals', title: 'Triage', target: { type: 'eval_suite', id: ID.suite, label: 'Triage suite' } },
      tab: 'runs',
    })
    const parsed = parseCardContext([entry])
    expect(renderCardsSection(parsed)).toContain('you switched to: runs')
    const read = await pageTools(on(), parsed).readCard({ card: 4, fields: ['outcome'] })
    expect(read).toMatchObject({ success: true, showing: 'eval runs', total: 1, rows: [{ title: 'batch run · pass · 2026-10-05', outcome: 'pass' }] })
  })

  it("never reads a teammate's private case the person opened by a forged id", async () => {
    const parsed = parseCardContext([
      buildCardContextEntry({ n: 1, id: 'c', spec: { kind: 'evals', title: 'E' }, at: { type: 'eval_case', id: ID.casePrivate } }),
    ])
    const read = await pageTools(on(), parsed).readCard({ card: 1 })
    expect(allText(read)).not.toContain('Kenan private case')
  })
})
