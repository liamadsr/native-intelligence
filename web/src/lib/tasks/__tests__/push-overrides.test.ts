/**
 * Tests for src/lib/tasks/push-overrides.ts — the per-push override contract.
 *
 * The invariant this file exists to protect above all others: an absent, empty
 * or `{}` override body folds to `undefined`, which is what makes every push
 * without a compose panel byte-identical to the behaviour that shipped before
 * overrides existed. Every other assertion here is about rejecting junk LOUDLY
 * rather than dropping it — a silently ignored field surfaces days later as
 * "the assignee didn't stick".
 */
import { describe, it, expect } from 'vitest'
import {
  parseAsanaOverrides,
  parseJiraOverrides,
  parseLinearOverrides,
  readOverridesBody,
} from '../push-overrides'

function post(body?: BodyInit): Request {
  return new Request('http://x', { method: 'POST', ...(body === undefined ? {} : { body }) })
}

// ---- readOverridesBody -----------------------------------------------------

describe('readOverridesBody', () => {
  it('reads NO body as absent — the byte-compatibility guarantee', async () => {
    expect(await readOverridesBody(post())).toEqual({ ok: true, value: undefined })
  })

  it('reads an empty body as absent', async () => {
    expect(await readOverridesBody(post(''))).toEqual({ ok: true, value: undefined })
  })

  it('reads whitespace as absent', async () => {
    expect(await readOverridesBody(post('   \n '))).toEqual({ ok: true, value: undefined })
  })

  it('folds `{}` and `{ overrides: {} }` to absent', async () => {
    expect(await readOverridesBody(post('{}'))).toEqual({ ok: true, value: undefined })
    expect(await readOverridesBody(post('{"overrides":{}}'))).toEqual({
      ok: true,
      value: undefined,
    })
    expect(await readOverridesBody(post('{"overrides":null}'))).toEqual({
      ok: true,
      value: undefined,
    })
  })

  it('returns the overrides object when present', async () => {
    const res = await readOverridesBody(post('{"overrides":{"title":"Hi"}}'))
    expect(res).toEqual({ ok: true, value: { title: 'Hi' } })
  })

  it('rejects a non-JSON body — the caller meant to send something', async () => {
    expect(await readOverridesBody(post('not json'))).toEqual({
      ok: false,
      error: 'Request body must be JSON',
    })
  })

  it.each([['[1,2]'], ['"str"'], ['7'], ['null']])('rejects the non-object body %s', async (body) => {
    const res = await readOverridesBody(post(body))
    expect(res.ok).toBe(false)
  })

  it('rejects unknown TOP-LEVEL body fields', async () => {
    const res = await readOverridesBody(post('{"overrides":{},"destination":{}}'))
    expect(res).toEqual({ ok: false, error: 'Unknown body field(s): destination' })
  })

  it('rejects a non-object `overrides`', async () => {
    const res = await readOverridesBody(post('{"overrides":[]}'))
    expect(res).toEqual({ ok: false, error: '`overrides` must be an object' })
  })
})

// ---- Jira ------------------------------------------------------------------

describe('parseJiraOverrides', () => {
  it('folds undefined to undefined', () => {
    expect(parseJiraOverrides(undefined)).toEqual({ ok: true, value: undefined })
  })

  it('accepts the full shape', () => {
    const res = parseJiraOverrides({
      title: 'Ship it',
      project_id: '10001',
      project_key: 'ENG',
      issue_type_id: '10002',
      issue_type_name: 'Task',
      assignee_account_id: 'acc-1',
      priority_id: '3',
      due_date: '2026-08-01',
      labels: ['alpha', 'beta'],
      custom_fields: { customfield_10041: { id: 'opt-9' } },
    })
    expect(res).toEqual({
      ok: true,
      value: {
        title: 'Ship it',
        project_id: '10001',
        project_key: 'ENG',
        issue_type_id: '10002',
        issue_type_name: 'Task',
        assignee_account_id: 'acc-1',
        priority_id: '3',
        due_date: '2026-08-01',
        labels: ['alpha', 'beta'],
        custom_fields: { customfield_10041: { id: 'opt-9' } },
      },
    })
  })

  it('trims strings', () => {
    const res = parseJiraOverrides({ title: '  Ship it  ' })
    expect(res).toEqual({ ok: true, value: { title: 'Ship it' } })
  })

  it('rejects unknown keys by NAME', () => {
    const res = parseJiraOverrides({ assignee_id: 'x' })
    expect(res).toEqual({ ok: false, error: 'Unknown jira override field(s): assignee_id' })
  })

  it('rejects an empty string rather than treating it as absent', () => {
    expect(parseJiraOverrides({ title: '   ' }).ok).toBe(false)
  })

  it('rejects a non-string field', () => {
    expect(parseJiraOverrides({ project_id: 10001 }).ok).toBe(false)
  })

  it.each([['2026-8-1'], ['08/01/2026'], ['2026-02-31'], ['2026-08-01T00:00:00Z']])(
    'rejects the malformed due_date %s',
    (value) => {
      expect(parseJiraOverrides({ due_date: value }).ok).toBe(false)
    },
  )

  it('accepts an empty labels array', () => {
    expect(parseJiraOverrides({ labels: [] })).toEqual({ ok: true, value: { labels: [] } })
  })

  it('rejects a labels array holding a non-string', () => {
    expect(parseJiraOverrides({ labels: ['ok', 3] }).ok).toBe(false)
  })

  /**
   * The required-custom-field wall's wire format. Only `{ id }` is accepted:
   * every custom field the panel renders came from an `allowedValues` list, and
   * a bare string would let a free-text field — the exact case the wall refuses
   * to guess at — through as if it had been picked.
   */
  it.each([
    [{ customfield_1: 'opt-9' }],
    [{ customfield_1: { value: 'opt-9' } }],
    [{ customfield_1: { id: '' } }],
    [{ customfield_1: { id: 'opt-9', value: 'x' } }],
  ])('rejects the custom_fields shape %o', (custom) => {
    expect(parseJiraOverrides({ custom_fields: custom }).ok).toBe(false)
  })

  /**
   * REGRESSION (review finding: "Jira custom_fields key namespace unvalidated —
   * system fields can be overwritten, bypassing the dependent-field wall").
   *
   * Only the VALUE shape was checked, never the KEY. jira-push spreads
   * `custom_fields` LAST into `fields`, after `project` and `issuetype`, and
   * `{ id }` is exactly the shape it writes for both — so a `project` entry
   * silently REPLACED the destination the wall below had just validated,
   * landing the issue in an unrelated project with a 201 and an ordinary link
   * row. Restricting keys to Jira's own customfield_<n> namespace makes the
   * wall non-bypassable; every entry the compose panel produces is keyed that
   * way already, so nothing legitimate is lost.
   */
  it.each([
    ['project'],
    ['issuetype'],
    ['summary'],
    ['duedate'],
    ['labels'],
    ['priority'],
    ['description'],
    ['customfield_'],
    ['customfield_abc'],
    ['Customfield_10041'],
  ])('rejects a custom_fields key outside the customfield_<n> namespace: %s', (key) => {
    const res = parseJiraOverrides({ custom_fields: { [key]: { id: '10999' } } })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toContain(key)
  })

  it('still accepts a real customfield_<n> key', () => {
    expect(parseJiraOverrides({ custom_fields: { customfield_10041: { id: 'opt-9' } } })).toEqual({
      ok: true,
      value: { custom_fields: { customfield_10041: { id: 'opt-9' } } },
    })
  })

  /**
   * A lone `custom_fields.project` also has to fail, not merely be inert: the
   * dependent-field wall below only inspects `out.project_id`, so before this
   * check a custom-field-shaped project retarget slipped past it entirely.
   */
  it('rejects a custom_fields project retarget even with no project_id present', () => {
    expect(parseJiraOverrides({ custom_fields: { project: { id: '10999' } } }).ok).toBe(false)
  })

  /**
   * The dependent-field rule. Rejected here so the message names the two
   * choices; Jira's own rejection names neither.
   */
  it('rejects an overridden project WITHOUT an issue type', () => {
    const res = parseJiraOverrides({ project_id: '10001' })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/issue_type_id/)
  })

  it('allows an issue-type override alone (same project)', () => {
    expect(parseJiraOverrides({ issue_type_id: '10002' })).toEqual({
      ok: true,
      value: { issue_type_id: '10002' },
    })
  })

  /**
   * REGRESSION (review finding: "Display-only override fields accepted alone
   * are silent no-ops").
   *
   * `project_key` and `issue_type_name` are carried for display/telemetry only
   * — no push function reads either. Accepting one ALONE therefore produced the
   * exact failure mode rule #1 ("unknown keys are REJECTED, not ignored")
   * exists to prevent: a caller who reasonably believes `project_key: 'PLAT'`
   * retargets the push (Jira's own APIs accept a project by key) gets a 201 and
   * an issue in the CONFIGURED project. The panel always sends these paired
   * with their id, so pairing them is zero-loss.
   */
  it('rejects a lone project_key with no project_id', () => {
    const res = parseJiraOverrides({ project_key: 'PLAT' })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/project_key/)
  })

  it('rejects a lone issue_type_name with no issue_type_id', () => {
    const res = parseJiraOverrides({ issue_type_name: 'Bug' })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/issue_type_name/)
  })

  it('still accepts the display fields when paired with their ids', () => {
    expect(
      parseJiraOverrides({
        project_id: '10001',
        project_key: 'PLAT',
        issue_type_id: '10002',
        issue_type_name: 'Bug',
      }),
    ).toEqual({
      ok: true,
      value: {
        project_id: '10001',
        project_key: 'PLAT',
        issue_type_id: '10002',
        issue_type_name: 'Bug',
      },
    })
  })
})

// ---- Asana -----------------------------------------------------------------

describe('parseAsanaOverrides', () => {
  it('accepts the full shape', () => {
    expect(
      parseAsanaOverrides({
        title: 'Ship it',
        project_gid: '111',
        project_name: 'Roadmap',
        section_gid: '222',
        assignee_gid: '333',
        due_on: '2026-08-01',
      }),
    ).toEqual({
      ok: true,
      value: {
        title: 'Ship it',
        project_gid: '111',
        project_name: 'Roadmap',
        section_gid: '222',
        assignee_gid: '333',
        due_on: '2026-08-01',
      },
    })
  })

  /** Asana has no native priority field, so there is nothing to override. */
  it('rejects `priority` — Asana has no such field', () => {
    expect(parseAsanaOverrides({ priority: 1 })).toEqual({
      ok: false,
      error: 'Unknown asana override field(s): priority',
    })
  })

  it('rejects `due_at` — the panel collects a date, and the two are exclusive', () => {
    expect(parseAsanaOverrides({ due_at: '2026-08-01T10:00:00Z' }).ok).toBe(false)
  })

  it('rejects a malformed due_on', () => {
    expect(parseAsanaOverrides({ due_on: 'tomorrow' }).ok).toBe(false)
  })

  /** A section override alone is legal: same project, different column. */
  it('allows a section override without a project override', () => {
    expect(parseAsanaOverrides({ section_gid: '222' })).toEqual({
      ok: true,
      value: { section_gid: '222' },
    })
  })

  /**
   * REGRESSION (review finding: "Display-only override fields accepted alone
   * are silent no-ops"). `project_name` is carried for display only — asana-push
   * selects on `project_gid` and never reads it — so accepting it alone landed
   * the task in the CONFIGURED project while answering 201. The panel always
   * sends it paired with the gid.
   */
  it('rejects a lone project_name with no project_gid', () => {
    const res = parseAsanaOverrides({ project_name: 'Roadmap' })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/project_name/)
  })

  it('still accepts project_name when paired with project_gid', () => {
    expect(parseAsanaOverrides({ project_gid: '111', project_name: 'Roadmap' })).toEqual({
      ok: true,
      value: { project_gid: '111', project_name: 'Roadmap' },
    })
  })
})

// ---- Linear ----------------------------------------------------------------

describe('parseLinearOverrides', () => {
  it('accepts the full shape', () => {
    expect(
      parseLinearOverrides({
        title: 'Ship it',
        team_id: 'team-1',
        project_id: 'proj-1',
        assignee_id: 'user-1',
        priority: 2,
        label_ids: ['lab-1', 'lab-2'],
        due_date: '2026-08-01',
      }),
    ).toEqual({
      ok: true,
      value: {
        title: 'Ship it',
        team_id: 'team-1',
        project_id: 'proj-1',
        assignee_id: 'user-1',
        priority: 2,
        label_ids: ['lab-1', 'lab-2'],
        due_date: '2026-08-01',
      },
    })
  })

  it('accepts priority 0 — "No priority" is a real choice, not absence', () => {
    expect(parseLinearOverrides({ priority: 0 })).toEqual({ ok: true, value: { priority: 0 } })
  })

  it.each([[-1], [5], [1.5], ['2'], [true]])('rejects the priority %o', (priority) => {
    expect(parseLinearOverrides({ priority }).ok).toBe(false)
  })

  /** A team override needs NO state: the push derives that team's own. */
  it('allows a team override alone — the start state is derived server-side', () => {
    expect(parseLinearOverrides({ team_id: 'team-2' })).toEqual({
      ok: true,
      value: { team_id: 'team-2' },
    })
  })

  it('rejects a state_id override — states are derived, never picked', () => {
    expect(parseLinearOverrides({ state_id: 'st-1' }).ok).toBe(false)
  })

  it('rejects label_ids holding a non-string', () => {
    expect(parseLinearOverrides({ label_ids: [null] }).ok).toBe(false)
  })
})

// ---- clearing a field vs never touching it ---------------------------------

/**
 * REGRESSION (review finding: "Explicit 'None'/cleared field choices silently
 * revert to config- or action-derived values").
 *
 * ABSENT means "inherit" — the push falls back to the workspace config or the
 * action's own assignee/due date, which is exactly what an untouched panel must
 * keep doing. NULL means "the user removed this", and the two cannot be the same
 * value or clearing a field silently reinstates it. Only the fields that HAVE a
 * fallback are clearable; everywhere else null is still just absent.
 */
describe('clearable overrides — null means clear, absent means inherit', () => {
  it('preserves an explicit null on jira’s clearable fields', () => {
    expect(parseJiraOverrides({ assignee_account_id: null, due_date: null })).toEqual({
      ok: true,
      value: { assignee_account_id: null, due_date: null },
    })
  })

  it('preserves an explicit null on asana’s clearable fields', () => {
    expect(
      parseAsanaOverrides({ section_gid: null, assignee_gid: null, due_on: null }),
    ).toEqual({
      ok: true,
      value: { section_gid: null, assignee_gid: null, due_on: null },
    })
  })

  it('preserves an explicit null on linear’s clearable fields', () => {
    expect(
      parseLinearOverrides({ project_id: null, assignee_id: null, due_date: null }),
    ).toEqual({
      ok: true,
      value: { project_id: null, assignee_id: null, due_date: null },
    })
  })

  it('a wholly absent body is still undefined, not a bag of nulls', () => {
    // The byte-compatibility rule: nothing supplied means nothing sent.
    expect(parseJiraOverrides({})).toEqual({ ok: true, value: undefined })
    expect(parseAsanaOverrides({})).toEqual({ ok: true, value: undefined })
    expect(parseLinearOverrides({})).toEqual({ ok: true, value: undefined })
  })

  it('still rejects an EMPTY STRING — that is malformed, not a clear', () => {
    // A clear is expressed as null and only as null; '' remains a client bug.
    expect(parseLinearOverrides({ assignee_id: '' }).ok).toBe(false)
    expect(parseJiraOverrides({ due_date: '' }).ok).toBe(false)
  })

  it('null on a NON-clearable field is still treated as absent', () => {
    // team_id/project_gid have no fallback to suppress — there is nothing a
    // clear could mean, so the old fold stands.
    expect(parseLinearOverrides({ team_id: null })).toEqual({ ok: true, value: undefined })
    expect(parseAsanaOverrides({ project_gid: null })).toEqual({ ok: true, value: undefined })
  })
})
