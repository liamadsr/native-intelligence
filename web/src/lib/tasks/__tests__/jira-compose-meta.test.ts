/**
 * Tests for src/lib/tasks/jira-compose-meta.ts — the compose panel's oracle.
 *
 * The classification is the whole file, and its three-way split is what these
 * tests pin. Getting it wrong fails in two opposite directions and both are bad:
 * classify a blocker as renderable and the panel offers a Create that is KNOWN
 * to 400; classify a satisfiable field as a blocker and the panel refuses a push
 * that would have worked.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  classifyCreateMeta,
  clearCreateMetaCache,
  createMetaCacheKey,
  nativeCreateIssueUrl,
  readCachedCreateMeta,
  writeCachedCreateMeta,
} from '../jira-compose-meta'
import type { JiraCreateMetaField } from '@/lib/integrations/jira-api'

function field(over: Partial<JiraCreateMetaField> & { fieldId: string }): JiraCreateMetaField {
  return over
}

// ---- Screen-gated natives --------------------------------------------------

describe('classifyCreateMeta — field presence', () => {
  /**
   * createmeta returns ONLY fields on the create screen, so absence is the
   * detector for "this would 400 with 'not on the appropriate screen'". This is
   * the whole reason the panel asks before rendering rather than after failing.
   */
  it('reports duedate ABSENT when the screen does not carry it', () => {
    const meta = classifyCreateMeta([field({ fieldId: 'summary', required: true })])
    expect(meta.has_due_date).toBe(false)
    expect(meta.due_date_required).toBe(false)
  })

  it('reports duedate present and its required flag', () => {
    const meta = classifyCreateMeta([field({ fieldId: 'duedate', required: true })])
    expect(meta).toMatchObject({ has_due_date: true, due_date_required: true })
  })

  it('reports labels and assignee presence independently', () => {
    const meta = classifyCreateMeta([
      field({ fieldId: 'labels', required: false }),
      field({ fieldId: 'assignee', required: true }),
    ])
    expect(meta).toMatchObject({
      has_labels: true,
      labels_required: false,
      has_assignee: true,
      assignee_required: true,
    })
  })
})

// ---- Priority --------------------------------------------------------------

describe('classifyCreateMeta — priority', () => {
  /**
   * createmeta's allowedValues is the ONLY in-scope source: /priority/search
   * needs manage:jira-configuration, a scope Dial8 does not hold.
   */
  it('lifts the priority options out of allowedValues', () => {
    const meta = classifyCreateMeta([
      field({
        fieldId: 'priority',
        required: false,
        allowedValues: [
          { id: '1', name: 'Highest' },
          { id: '3', name: 'Medium' },
        ],
      }),
    ])
    expect(meta.has_priority).toBe(true)
    expect(meta.priorities).toEqual([
      { id: '1', name: 'Highest' },
      { id: '3', name: 'Medium' },
    ])
  })

  it('reports no priority field and an empty option list when absent', () => {
    const meta = classifyCreateMeta([field({ fieldId: 'summary' })])
    expect(meta.has_priority).toBe(false)
    expect(meta.priorities).toEqual([])
  })

  it('falls back to `value` then the id for an option with no name', () => {
    const meta = classifyCreateMeta([
      field({
        fieldId: 'priority',
        allowedValues: [{ id: '1', value: 'Urgent' }, { id: '2' }],
      }),
    ])
    expect(meta.priorities).toEqual([
      { id: '1', name: 'Urgent' },
      { id: '2', name: '2' },
    ])
  })

  /** `{ id }` is the only shape the create accepts, so an idless option is unusable. */
  it('drops an allowedValue with no id', () => {
    const meta = classifyCreateMeta([
      field({ fieldId: 'priority', allowedValues: [{ name: 'Nameless' }, { id: '1', name: 'A' }] }),
    ])
    expect(meta.priorities).toEqual([{ id: '1', name: 'A' }])
  })
})

// ---- The required-custom-field wall ----------------------------------------

describe('classifyCreateMeta — required custom fields', () => {
  it('renders a required custom field WITH allowedValues as a dropdown', () => {
    const meta = classifyCreateMeta([
      field({
        fieldId: 'customfield_10041',
        name: 'Team',
        required: true,
        allowedValues: [{ id: 'opt-1', value: 'Platform' }],
      }),
    ])
    expect(meta.custom_fields).toEqual([
      {
        field_id: 'customfield_10041',
        name: 'Team',
        required: true,
        options: [{ id: 'opt-1', name: 'Platform' }],
      },
    ])
    expect(meta.blocking_fields).toEqual([])
  })

  /**
   * THE WALL. Free text, cascading selects, sprint/epic pickers — no generic
   * value to invent, so Create is disabled and the panel links out rather than
   * minting a create known to 400.
   */
  it('BLOCKS on a required custom field with no allowedValues and no default', () => {
    const meta = classifyCreateMeta([
      field({
        fieldId: 'customfield_10050',
        name: 'Epic Link',
        required: true,
        schema: { type: 'any', custom: 'com.pyxis.greenhopper.jira:gh-epic-link' },
      }),
    ])
    expect(meta.blocking_fields).toEqual([
      { field_id: 'customfield_10050', name: 'Epic Link', schema_type: 'any' },
    ])
    expect(meta.custom_fields).toEqual([])
  })

  /** Jira fills it itself — nothing to ask, nothing to block on. */
  it('does NOT block a required field carrying hasDefaultValue', () => {
    const meta = classifyCreateMeta([
      field({ fieldId: 'customfield_10060', name: 'Sprint', required: true, hasDefaultValue: true }),
    ])
    expect(meta.blocking_fields).toEqual([])
    expect(meta.custom_fields).toEqual([])
  })

  /** Optional means optional: an unrendered optional field is simply left unset. */
  it('ignores an OPTIONAL custom field entirely', () => {
    const meta = classifyCreateMeta([
      field({ fieldId: 'customfield_10070', name: 'Notes', required: false }),
    ])
    expect(meta.blocking_fields).toEqual([])
    expect(meta.custom_fields).toEqual([])
  })

  /**
   * The natives the panel draws itself must NEVER become blockers just because
   * the project marks them required — the panel already collects them, and
   * `summary`/`project`/`issuetype` are on every create by construction.
   */
  it.each([
    'summary',
    'project',
    'issuetype',
    'description',
    'assignee',
    'priority',
    'duedate',
    'labels',
    'reporter',
  ])('never blocks on the required native `%s`', (fieldId) => {
    const meta = classifyCreateMeta([field({ fieldId, required: true })])
    expect(meta.blocking_fields).toEqual([])
  })

  it('falls back to the fieldId when a custom field has no name', () => {
    const meta = classifyCreateMeta([field({ fieldId: 'customfield_10099', required: true })])
    expect(meta.blocking_fields[0].name).toBe('customfield_10099')
  })

  it('separates renderable and blocking customs in the same screen', () => {
    const meta = classifyCreateMeta([
      field({ fieldId: 'customfield_1', name: 'A', required: true, allowedValues: [{ id: 'x' }] }),
      field({ fieldId: 'customfield_2', name: 'B', required: true }),
    ])
    expect(meta.custom_fields.map((f) => f.field_id)).toEqual(['customfield_1'])
    expect(meta.blocking_fields.map((f) => f.field_id)).toEqual(['customfield_2'])
  })

  it('ignores a field with no fieldId rather than emitting a nameless blocker', () => {
    const meta = classifyCreateMeta([
      { required: true } as JiraCreateMetaField,
      field({ fieldId: 'summary' }),
    ])
    expect(meta.blocking_fields).toEqual([])
  })
})

// ---- Link-out --------------------------------------------------------------

describe('nativeCreateIssueUrl', () => {
  it('builds the native create screen URL', () => {
    expect(nativeCreateIssueUrl('https://acme.atlassian.net', '10000', '10001')).toBe(
      'https://acme.atlassian.net/secure/CreateIssue.jspa?pid=10000&issuetype=10001',
    )
  })

  it('trims a trailing slash on the site url', () => {
    expect(nativeCreateIssueUrl('https://acme.atlassian.net/', '1', '2')).toBe(
      'https://acme.atlassian.net/secure/CreateIssue.jspa?pid=1&issuetype=2',
    )
  })

  /** An absent button is honest; one that 404s is not. */
  it.each([[null], [undefined], ['']])('returns null for the site url %o', (site) => {
    expect(nativeCreateIssueUrl(site, '1', '2')).toBeNull()
  })
})

// ---- Cache -----------------------------------------------------------------

describe('createmeta cache', () => {
  beforeEach(() => clearCreateMetaCache())

  it('round-trips a field list', () => {
    const key = createMetaCacheKey('ws-1', 'cafe', '10000', '10001')
    expect(readCachedCreateMeta(key)).toBeNull()
    writeCachedCreateMeta(key, [field({ fieldId: 'duedate' })])
    expect(readCachedCreateMeta(key)).toEqual([{ fieldId: 'duedate' }])
  })

  /**
   * WORKSPACE is part of the key because createmeta is permission-filtered: two
   * workspaces reaching the same site with different tokens see different
   * fields, and sharing an entry would leak one's screen into the other's panel.
   */
  it('keys by workspace, site, project AND type', () => {
    const base = createMetaCacheKey('ws-1', 'cafe', '10000', '10001')
    expect(createMetaCacheKey('ws-2', 'cafe', '10000', '10001')).not.toBe(base)
    expect(createMetaCacheKey('ws-1', 'beef', '10000', '10001')).not.toBe(base)
    expect(createMetaCacheKey('ws-1', 'cafe', '20000', '10001')).not.toBe(base)
    expect(createMetaCacheKey('ws-1', 'cafe', '10000', '20001')).not.toBe(base)
  })
})
