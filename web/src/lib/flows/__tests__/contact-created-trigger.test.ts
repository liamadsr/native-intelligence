/**
 * The contact_created trigger: its config, who may emit and when, what never
 * fires, which contacts a loop takes, who a fire is for (failing closed), and
 * what a run gets (the contact's id, never its name).
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CONTACT_CREATED_PERSON_DELAY_MS, emitContactCreated, notifyContactCreated } from '../emit-contact-created'
import {
  contactFlowsToFire,
  contactOriginOf,
  contactSkipReason,
  contactSourceMatches,
  eventTriggerTargetProblem,
  loadContactFacts,
  ownerCanSeeContact,
  workspaceHasEventFlows,
  type ContactFacts,
} from '../event-triggers'
import { validateContactCreatedConfig, validateTriggerConfig } from '../queries'
import { TEMPLATE_TOKENS, buildTemplateContext } from '../template'
import { entitylessTestTrigger } from '../test-fire'
import { flowRunPrivateTo, isOwnerEventTrigger, triggerConfigForViewer, type FlowWithSecrets } from '../types'

const WS = 'ws-fernhill'
const CONTACT = '55555555-5555-4555-8555-555555555555'

describe('the config', () => {
  it("takes any contact by default, or a form's, or a person's own; nothing else is kept", () => {
    expect(validateContactCreatedConfig(undefined)).toEqual({ kind: 'contact_created', source: 'any' })
    expect(validateContactCreatedConfig(null)).toEqual({ kind: 'contact_created', source: 'any' })
    expect(validateContactCreatedConfig({})).toEqual({ kind: 'contact_created', source: 'any' })
    expect(validateContactCreatedConfig({ source: 'form', anything: 'else' })).toEqual({ kind: 'contact_created', source: 'form' })
    expect(validateTriggerConfig('contact_created', { source: 'manual' })).toEqual({ kind: 'contact_created', source: 'manual' })
  })

  it.each([{ source: 'csv_import' }, { source: 'Form' }, { source: 3 }, [], 'form'])('refuses %j', (raw) => {
    expect(validateContactCreatedConfig(raw)).toBeInstanceOf(Error)
  })

  it('has no target to check at save', async () => {
    const supabase = {} as SupabaseClient
    expect(await eventTriggerTargetProblem(supabase, { workspaceId: WS, ownerUserId: 'u-ana', triggerType: 'contact_created', config: { source: 'any' } })).toBeNull()
  })
})

describe('the emitter', () => {
  it("a form's contact fires at once, a person's about five minutes later, once per contact", async () => {
    const now = Date.parse('2026-11-15T12:00:00Z')
    const send = vi.fn(async (_event: { id: string; ts?: number }) => {})
    expect(await emitContactCreated({ workspaceId: WS, contactId: 'c-1', source: 'form', now }, { send })).toBe(true)
    expect(send).toHaveBeenCalledWith({ name: 'flow/contact.created', id: 'contact-created:c-1', data: { workspace_id: WS, contact_id: 'c-1', source: 'form', created_at: '2026-11-15T12:00:00.000Z' } })
    send.mockClear()
    await emitContactCreated({ workspaceId: WS, contactId: 'c-2', source: 'person', now }, { send })
    expect(send.mock.calls[0][0]).toMatchObject({ id: 'contact-created:c-2', ts: now + CONTACT_CREATED_PERSON_DELAY_MS })
    expect(CONTACT_CREATED_PERSON_DELAY_MS).toBe(5 * 60 * 1000)
  })

  it('a failed send never throws', async () => {
    const failing = vi.fn(async () => {
      throw new Error('inngest down')
    })
    expect(await emitContactCreated({ workspaceId: WS, contactId: 'c-1', source: 'form' }, { send: failing })).toBe(false)
  })

  it('asks first whether the workspace has a contact loop, and sends nothing when it has none', async () => {
    const send = vi.fn(async () => {})
    const none = vi.fn(async () => false)
    expect(await notifyContactCreated({} as SupabaseClient, { workspaceId: WS, contactId: 'c-1', source: 'person' }, { send, hasFlows: none })).toBe(false)
    expect(none).toHaveBeenCalledWith({}, { workspaceId: WS, triggerType: 'contact_created' })
    expect(send).not.toHaveBeenCalled()
    expect(await notifyContactCreated({} as SupabaseClient, { workspaceId: WS, contactId: 'c-1', source: 'person' }, { send, hasFlows: async () => true })).toBe(true)
    expect(send).toHaveBeenCalledOnce()
    const throwing = async () => {
      throw new Error('down')
    }
    expect(await notifyContactCreated({} as SupabaseClient, { workspaceId: WS, contactId: 'c-1', source: 'person' }, { send, hasFlows: throwing })).toBe(false)
  })

  it("the gate reads the workspace's enabled contact loops", async () => {
    const filters: Record<string, unknown> = {}
    const q = {
      select: () => q,
      eq: (col: string, v: unknown) => ((filters[col] = v), q),
      limit: async () => ({ count: 1, error: null }),
    }
    const supabase = { from: () => q } as unknown as SupabaseClient
    expect(await workspaceHasEventFlows(supabase, { workspaceId: WS, triggerType: 'contact_created' })).toBe(true)
    expect(filters).toEqual({ workspace_id: WS, enabled: true, trigger_type: 'contact_created' })
  })
})

describe('what never fires', () => {
  const contact = (over: Partial<ContactFacts> = {}): ContactFacts => ({ id: 'c-1', workspace_id: WS, merged: false, origin: 'form', ...over })

  it('a contact gone, in another workspace, merged since, or of a source no emitter writes', () => {
    expect(contactSkipReason(contact(), WS)).toBeNull()
    expect(contactSkipReason(contact({ origin: 'manual' }), WS)).toBeNull()
    expect(contactSkipReason(null, WS)).toBe('deleted')
    expect(contactSkipReason(contact({ workspace_id: 'ws-2' }), WS)).toBe('deleted')
    expect(contactSkipReason(contact({ merged: true }), WS)).toBe('merged')
    expect(contactSkipReason(contact({ origin: null }), WS)).toBe('not made by a form or a person')
  })

  it("reads a contact's source as a loop's: a public intake's, a person's, else none", () => {
    expect(contactOriginOf('web_form')).toBe('form')
    expect(contactOriginOf('sms')).toBe('form')
    expect(contactOriginOf('manual')).toBe('manual')
    for (const s of ['email_sync', 'calendar_sync', 'capture_participant', 'csv_import', 'hubspot', 'member', 'prospecting', null, undefined]) expect(contactOriginOf(s), String(s)).toBeNull()
  })

  it('loads ids and flags only, never the name', async () => {
    let selected = ''
    const q = {
      select: (cols: string) => ((selected = cols), q),
      eq: () => q,
      maybeSingle: async () => ({ data: { id: 'c-1', workspace_id: WS, merged_into_contact_id: 'c-0', source: 'sms' }, error: null }),
    }
    const supabase = { from: () => q } as unknown as SupabaseClient
    expect(await loadContactFacts(supabase, 'c-1')).toEqual({ id: 'c-1', workspace_id: WS, merged: true, origin: 'form' })
    expect(selected).not.toMatch(/name|email|phone|notes/)
    const g = { select: () => g, eq: () => g, maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }
    const gone = { from: () => g } as unknown as SupabaseClient
    expect(await loadContactFacts(gone, 'c-1')).toBeNull()
  })
})

describe('which contacts a loop takes', () => {
  it('any takes both; form and manual each take their own; a stored loop without a source takes any', () => {
    expect(contactSourceMatches({ source: 'any' }, 'form')).toBe(true)
    expect(contactSourceMatches({ source: 'any' }, 'manual')).toBe(true)
    expect(contactSourceMatches({ source: 'form' }, 'form')).toBe(true)
    expect(contactSourceMatches({ source: 'form' }, 'manual')).toBe(false)
    expect(contactSourceMatches({ source: 'manual' }, 'manual')).toBe(true)
    expect(contactSourceMatches({ source: 'manual' }, 'form')).toBe(false)
    expect(contactSourceMatches({}, 'form')).toBe(true)
    expect(contactSourceMatches(null, 'manual')).toBe(true)
    expect(contactSourceMatches({ source: 'any' }, null)).toBe(false)
  })
})

/** A client whose contact_visible_to answers per user. */
function client(visible: Record<string, string[]>) {
  const rpc = vi.fn(async (_name: string, args: { p_contact_id: string; p_user_id: string; p_grants?: boolean }) => ({ data: (visible[args.p_user_id] ?? []).includes(args.p_contact_id), error: null }))
  return { supabase: { rpc } as unknown as SupabaseClient, rpc }
}

describe('who a fire is for', () => {
  const flow = (id: string, owner: string | null, source: string = 'any') => ({ id, created_by: owner, trigger_config: { kind: 'contact_created', source } }) as unknown as FlowWithSecrets

  it('only loops that take its source and whose owner sees the contact without a grant', async () => {
    const { supabase, rpc } = client({ 'u-ana': [CONTACT], 'u-cy': [] })
    const fired = await contactFlowsToFire(
      supabase,
      [flow('a', 'u-ana'), flow('a2', 'u-ana', 'form'), flow('a3', 'u-ana', 'manual'), flow('c', 'u-cy'), flow('x', null)],
      { id: CONTACT, origin: 'form' },
    )
    expect(fired.map((f) => f.id)).toEqual(['a', 'a2'])
    // Asked once per owner, by the contact read rule, never with grants: an unattended run reads none.
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc.mock.calls.every(([name, a]) => name === 'contact_visible_to' && a.p_grants === false)).toBe(true)
  })

  it('fails closed when the rule cannot be read', async () => {
    const failing = { rpc: async () => ({ data: null, error: { message: 'down' } }) } as unknown as SupabaseClient
    expect(await ownerCanSeeContact(failing, 'u-ana', CONTACT)).toBe(false)
    const throwing = {
      rpc: async () => {
        throw new Error('down')
      },
    } as unknown as SupabaseClient
    expect(await ownerCanSeeContact(throwing, 'u-ana', CONTACT)).toBe(false)
    expect(await contactFlowsToFire(throwing, [flow('a', 'u-ana')], { id: CONTACT, origin: 'manual' })).toEqual([])
  })
})

describe("an owner's own event", () => {
  it('its runs are private to the owner; its config names nothing private, so a viewer sees it as stored', () => {
    expect(isOwnerEventTrigger('contact_created')).toBe(true)
    expect(flowRunPrivateTo('contact_created', 'u-ana')).toBe('u-ana')
    expect(triggerConfigForViewer('contact_created', { kind: 'contact_created', source: 'form' }, false)).toEqual({ kind: 'contact_created', source: 'form' })
  })

  it('a step gets the id only, and a test fire names a contact that is not there', () => {
    expect(TEMPLATE_TOKENS).toContain('{{trigger.contact_id}}')
    const t = entitylessTestTrigger('contact_created', { source: 'any' }, '2026-11-15T12:00:00Z')
    expect(t).toMatchObject({ type: 'contact_created', entity_type: null })
    expect(t.contact_id).toMatch(/^[0-9a-f-]{36}$/)
    const ctx = buildTemplateContext(null, { type: 'contact_created', entity_type: null, from_status_id: null, to_status_id: null, fired_at: 'now', contact_id: CONTACT }, 'https://app.example', { workspaceId: WS })
    expect(ctx.trigger.contact_id).toBe(CONTACT)
  })
})
