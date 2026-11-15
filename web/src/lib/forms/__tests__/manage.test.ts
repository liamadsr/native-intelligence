/**
 * Managing forms (../manage.ts), the rule the tools and the REST routes
 * share: what a setting may be, a new form's defaults (the bot check on),
 * who may change a table, the personal links asked for, and the two views of
 * a form, neither of which ever holds its secret.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DataColumn, DataTableWithColumns } from '@/lib/tables/types'

const hoisted = vi.hoisted(() => ({ hidden: new Set<string>() }))
vi.mock('@/lib/knowledge/entity-fences', () => ({ hiddenGraphRefs: vi.fn(async () => hoisted.hidden) }))

import { cleanFormSettings, cleanInviteRequests, describeForm, embedSnippet, formForApi, formLinks, inviteRefusal, prepareFormPatch, prepareNewForm, tableEditRefusal } from '../manage'
import { FORM_TITLE_KEY, type DataForm } from '../types'

const col = (key: string, label: string, field_type: DataColumn['field_type']): DataColumn => ({ id: `c-${key}`, table_id: 't1', key, label, field_type, options: [], config: {}, position: 0, deleted_at: null })
const TABLE: DataTableWithColumns = {
  id: '33333333-3333-4333-8333-333333333333',
  workspace_id: 'ws-1',
  name: 'Website leads',
  icon: null,
  description: null,
  owner_member_id: 'm-1',
  visibility: 'workspace',
  version: 1,
  position: 0,
  archived_at: null,
  created_at: '',
  updated_at: '',
  columns: [col('email', 'Email', 'email'), col('owner', 'Owner', 'person')],
}
const WHO = { workspaceId: 'ws-1', userId: 'u-1' }
/** The form a change is made to: its fields and its bot check as they are. */
const CURRENT = { fields: [{ key: FORM_TITLE_KEY, label: 'Name', required: false }], botCheck: false }
const KEY = `fk_${'a'.repeat(43)}`

/** A pipeline (540): its system Stage (Lead, Won), Value and Owner, and a plain Email column. */
const PIPELINE: DataTableWithColumns = {
  ...TABLE,
  id: '44444444-4444-4444-8444-444444444444',
  name: 'Sales',
  kind: 'pipeline',
  columns: [
    { ...col('stage', 'Stage', 'select'), options: ['Lead', 'Won'], config: { outcomes: { Won: 'won' } }, system: true },
    { ...col('value', 'Value', 'currency'), system: true },
    { ...col('expected_close', 'Expected close', 'date'), system: true },
    { ...col('owner', 'Owner', 'person'), system: true },
    col('email', 'Email', 'email'),
  ],
}

describe('a form on a pipeline', () => {
  it('is made: each submission a new deal', () => {
    const made = prepareNewForm(PIPELINE, WHO, { fields: [{ key: FORM_TITLE_KEY, required: true }, { key: 'email' }, { key: 'value' }, { key: 'expected_close' }] })
    expect(made).toMatchObject({ ok: true, value: { tableId: PIPELINE.id, name: 'Sales' } })
  })

  it('never lists the Stage column, nor the owner, a company or contacts: a stranger never picks them', () => {
    for (const key of ['stage', 'owner']) {
      const out = prepareNewForm(PIPELINE, WHO, { fields: [{ key: FORM_TITLE_KEY }, { key }] })
      expect(out.ok, key).toBe(false)
      expect((out as { error: string }).error, key).toContain("can't be on a form")
    }
    const patch = prepareFormPatch(PIPELINE, 'u-1', { fields: [{ key: 'stage' }] }, CURRENT)
    expect(patch).toMatchObject({ ok: false })
  })

  it("asks what its first open stage needs, as a required field, or is refused", () => {
    const strict: DataTableWithColumns = {
      ...PIPELINE,
      columns: PIPELINE.columns.map((c) => (c.key === 'value' ? { ...c, config: { required_when: { key: 'stage', option: 'Lead' } } } : c)),
    }
    const without = prepareNewForm(strict, WHO, { fields: [{ key: FORM_TITLE_KEY }, { key: 'email' }] })
    expect((without as { error: string }).error).toContain('starts in Lead, which needs Value')
    expect(prepareNewForm(strict, WHO, { fields: [{ key: FORM_TITLE_KEY }, { key: 'value' }] }).ok).toBe(false)
    expect(prepareNewForm(strict, WHO, { fields: [{ key: FORM_TITLE_KEY }, { key: 'value', required: true }] }).ok).toBe(true)
    expect(prepareFormPatch(strict, 'u-1', { fields: [{ key: 'email' }] }, CURRENT).ok).toBe(false)
    // A rule on a later stage (Won needs Value) is not the form's: its deals start in Lead.
    const later: DataTableWithColumns = { ...PIPELINE, columns: PIPELINE.columns.map((c) => (c.key === 'value' ? { ...c, config: { required_when: { key: 'stage', option: 'Won' } } } : c)) }
    expect(prepareNewForm(later, WHO, { fields: [{ key: 'email' }] }).ok).toBe(true)
  })
})

describe('a new form', () => {
  it("is named for its table, open to anyone with the link, with the bot check ON unless said otherwise", () => {
    const made = prepareNewForm(TABLE, WHO, { fields: [{ key: FORM_TITLE_KEY, required: true }, { key: 'email' }] })
    expect(made).toEqual({
      ok: true,
      value: {
        workspaceId: 'ws-1',
        tableId: TABLE.id,
        userId: 'u-1',
        name: 'Website leads',
        fields: [
          { key: FORM_TITLE_KEY, label: 'Name', required: true },
          { key: 'email', label: 'Email', required: false },
        ],
        access: 'public',
        allowedOrigins: [],
        thanks: null,
        description: null,
        submitLabel: null,
        botCheck: true,
      },
    })
    expect(prepareNewForm(TABLE, WHO, { fields: [{ key: 'email' }], botCheck: false, access: 'invited', submitLabel: 'Book it' })).toMatchObject({ ok: true, value: { botCheck: false, access: 'invited', submitLabel: 'Book it' } })
  })

  it.each([
    ['an archived table', { ...TABLE, archived_at: 'x' }, { fields: [{ key: 'email' }] }, 'is archived'],
    ['a person column', TABLE, { fields: [{ key: 'owner' }] }, "can't be on a form"],
    ['no fields', TABLE, { fields: [] }, 'at least one field'],
    ['an access that is not one', TABLE, { fields: [{ key: 'email' }], access: 'everyone' }, 'Who can submit'],
    ['a description over 1000', TABLE, { fields: [{ key: 'email' }], description: 'x'.repeat(1001) }, 'at most 1000'],
    ['a button over 40', TABLE, { fields: [{ key: 'email' }], submitLabel: 'x'.repeat(41) }, 'at most 40'],
    ['a site that is not https', TABLE, { fields: [{ key: 'email' }], allowedOrigins: ['javascript:alert(1)'] }, 'https address'],
    ['a bot check that is not true or false', TABLE, { fields: [{ key: 'email' }], botCheck: 'yes' }, 'bot_check'],
  ])('refuses %s', (_what, table, input, error) => {
    const out = prepareNewForm(table as DataTableWithColumns, WHO, input)
    expect(out.ok).toBe(false)
    expect((out as { error: string }).error).toContain(error)
  })
})

describe('a change to a form', () => {
  it('holds only what was asked; null clears a line; new_link names who it is written as; nothing asked is refused', () => {
    expect(prepareFormPatch(TABLE, 'u-1', { active: false }, CURRENT)).toEqual({ ok: true, value: { active: false } })
    expect(prepareFormPatch(TABLE, 'u-1', { description: null, thanks: '', submitLabel: 'Send it' }, CURRENT)).toEqual({ ok: true, value: { description: null, thanks: null, submitLabel: 'Send it' } })
    expect(prepareFormPatch(TABLE, 'u-1', { newLink: true }, CURRENT)).toEqual({ ok: true, value: { newLink: { userId: 'u-1' } } })
    expect(prepareFormPatch(TABLE, 'u-1', { fields: [{ key: 'email', label: 'Your email', required: true }] }, CURRENT)).toMatchObject({ ok: true, value: { fields: [{ key: 'email', label: 'Your email', required: true }] } })
    expect(prepareFormPatch(TABLE, 'u-1', {}, CURRENT)).toEqual({ ok: false, error: 'Nothing to change.' })
    expect(prepareFormPatch(TABLE, 'u-1', { name: '' }, CURRENT).ok).toBe(false)
    expect(cleanFormSettings({ allowedOrigins: ['https://brightweave.example/page'] })).toEqual({ ok: true, value: { allowedOrigins: ['https://brightweave.example'] } })
  })
})

/** The asker's member row and the editable answer, as the database gives them. */
function memberDb(member: { id: string; role: string } | null, editable = false) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: member, error: null }) }) }) }) }),
    rpc: vi.fn(async () => ({ data: editable, error: null })),
  } as unknown as SupabaseClient
}

describe('who may change a table', () => {
  const shared = { ...TABLE, visibility: 'private' as const, owner_member_id: 'm-2' }
  it('a member: a workspace table, or their own private one', async () => {
    expect(await tableEditRefusal(memberDb({ id: 'm-1', role: 'member' }), { ...WHO, table: TABLE, editGrants: true })).toBeNull()
    expect(await tableEditRefusal(memberDb({ id: 'm-2', role: 'member' }), { ...WHO, table: shared, editGrants: false })).toBeNull()
  })

  it('never a guest or a stranger', async () => {
    expect(await tableEditRefusal(memberDb({ id: 'm-1', role: 'guest' }), { ...WHO, table: TABLE, editGrants: true })).toContain('guest')
    expect(await tableEditRefusal(memberDb(null), { ...WHO, table: TABLE, editGrants: true })).toBe('Table not found.')
  })

  it("a table shared with them: only with an edit grant, and from the tools only on their own attended turn", async () => {
    expect(await tableEditRefusal(memberDb({ id: 'm-1', role: 'member' }, true), { ...WHO, table: shared, editGrants: false })).toContain('shared with the person')
    expect(await tableEditRefusal(memberDb({ id: 'm-1', role: 'member' }, false), { ...WHO, table: shared, editGrants: true })).toContain('view')
    expect(await tableEditRefusal(memberDb({ id: 'm-1', role: 'member' }, true), { ...WHO, table: shared, editGrants: true })).toBeNull()
  })
})

describe('personal links asked for', () => {
  const contacts = (ids: string[]) =>
    ({ from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: ids.map((id) => ({ id })), error: null }) }) }) }) }) as unknown as SupabaseClient
  const C1 = '11111111-1111-4111-8111-111111111111'
  const C2 = '22222222-2222-4222-8222-222222222222'

  it('each with its label and a contact the asker can see', async () => {
    hoisted.hidden = new Set()
    expect(await cleanInviteRequests(contacts([C1]), WHO, [{ label: 'Sam Rivera', contact_id: C1 }, {}])).toEqual({
      ok: true,
      value: [
        { label: 'Sam Rivera', contactId: C1 },
        { label: null, contactId: null },
      ],
    })
  })

  it("refuses a contact that isn't there or that they can't see, none, too many, or a label too long", async () => {
    hoisted.hidden = new Set()
    expect((await cleanInviteRequests(contacts([]), WHO, [{ contact_id: C1 }])).ok).toBe(false)
    hoisted.hidden = new Set([`contact:${C2}`])
    expect(await cleanInviteRequests(contacts([C2]), WHO, [{ contact_id: C2 }])).toEqual({ ok: false, error: `No contact ${C2} that you can see.` })
    expect((await cleanInviteRequests(contacts([]), WHO, [])).ok).toBe(false)
    expect((await cleanInviteRequests(contacts([]), WHO, Array.from({ length: 51 }, () => ({})))).ok).toBe(false)
    expect((await cleanInviteRequests(contacts([]), WHO, [{ label: 'x'.repeat(121) }])).ok).toBe(false)
    expect((await cleanInviteRequests(contacts([]), WHO, [{ contact_id: 'not-an-id' }])).ok).toBe(false)
  })

  it('only an invited form, switched on, takes them', () => {
    expect(inviteRefusal({ access: 'public', active: true })).toContain('invited')
    expect(inviteRefusal({ access: 'invited', active: false })).toContain('switched off')
    expect(inviteRefusal({ access: 'invited', active: true })).toBeNull()
  })
})

describe('a form as the agent and the builder read it', () => {
  const FORM: DataForm = {
    id: 'form-1',
    workspaceId: 'ws-1',
    tableId: TABLE.id,
    name: 'Contact us',
    fields: [
      { key: FORM_TITLE_KEY, label: 'Full name', required: true },
      { key: 'email', label: 'Email', required: false },
      { key: 'gone', label: 'Gone', required: false },
    ],
    access: 'invited',
    allowedOrigins: [],
    thanks: null,
    description: 'Tell us.',
    submitLabel: null,
    botCheck: true,
    active: true,
    keyPrefix: 'fk_aaaaaa',
    createdBy: 'u-1',
    createdAt: 'c',
    updatedAt: 'u',
    lastSubmittedAt: null,
  }

  it('the builder gets every setting and each field by its column key; the page address is not known', () => {
    const api = formForApi(FORM, TABLE)
    expect(api).toMatchObject({ id: 'form-1', access: 'invited', who_can_submit: 'people with a personal link', bot_check: true, description: 'Tell us.', page_url_known: false })
    expect(api.fields).toEqual([
      { key: FORM_TITLE_KEY, label: 'Full name', required: true, post_as: 'full_name', type: 'text' },
      { key: 'email', label: 'Email', required: false, post_as: 'email', type: 'email' },
      { key: 'gone', label: 'Gone', required: false, post_as: 'gone', type: null, gone: true },
    ])
    expect(describeForm(FORM, TABLE)).toMatchObject({ who_can_submit: 'people with a personal link', description: 'Tell us.', bot_check: true })
  })

  it('a secret is shown only in its links: the intake, the page, and for a public form the embed', () => {
    expect(formLinks('https://nativeintelligence.dev/', KEY, 'public')).toEqual({
      url: `https://nativeintelligence.dev/api/intake/forms/${KEY}`,
      page_url: `https://nativeintelligence.dev/f/${KEY}`,
      embed: `<div data-ni-form="${KEY}"></div><script async src="https://nativeintelligence.dev/f/embed.js"></script>`,
    })
    expect(formLinks('https://nativeintelligence.dev', KEY, 'members').embed).toBeUndefined()
    expect(embedSnippet('https://x.example', KEY)).toContain('/f/embed.js')
  })
})
