/**
 * The entity actions registry: every registered kind decides how it opens and
 * what it offers, every route it names exists and takes the verb it is sent,
 * and a kind with no archive never offers one.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENTITY_REGISTRY, ENTITY_REGISTRY_BY_ID, type EntityType } from '@/lib/knowledge/entity-registry'
import { CARD_RECORD_TYPES } from '@/lib/chat-cards/kinds'
import { PAGE_DEEP_LINK_PLACES, cardForTarget, studioVideoLink } from '@/lib/chat-cards/open-card'
import { isMentionableType } from '@/lib/entity-links/mentionable'
import { entityOpenTarget } from '@/lib/entity-links/open-entity'
import {
  DEEP_LINK_TYPES,
  ENTITY_ACTIONS,
  STUDIO_PAGE_LINKS,
  entityIdText,
  entityLink,
  isArchivedRow,
  supportedEntityActions,
} from '../entity-actions-registry'

const ids = ENTITY_REGISTRY.map((e) => e.id as EntityType)
const API = join(__dirname, '../../../app/api/account')
const routeFile = (route: string) => join(API, route, '[id]', 'route.ts')
const exportsVerb = (route: string, verb: string) =>
  new RegExp(`export async function ${verb}\\b`).test(readFileSync(routeFile(route), 'utf8'))

describe('ENTITY_ACTIONS', () => {
  it('has exactly one entry for every registered kind', () => {
    expect(Object.keys(ENTITY_ACTIONS).sort()).toEqual([...ids].sort())
  })

  it('every entry decides every field (none left undefined)', () => {
    for (const id of ids) {
      const d = ENTITY_ACTIONS[id]
      for (const field of ['open', 'link', 'rename', 'archive', 'share', 'makeTask'] as const) {
        expect(d[field], `${id}.${field}`).not.toBeUndefined()
      }
      if (d.archive.kind === 'none') expect(d.archive.why.length, `${id} says why it has no archive`).toBeGreaterThan(10)
    }
  })

  it("renames through the kind's own title column", () => {
    for (const id of ids) {
      const r = ENTITY_ACTIONS[id].rename
      if (!r) continue
      // The registry's label column is the kind's title.
      expect(r.field, id).toBe(ENTITY_REGISTRY_BY_ID[id].label.columns)
    }
  })

  it('names only routes that exist and take the verb sent to them', () => {
    for (const id of ids) {
      const { rename, archive } = ENTITY_ACTIONS[id]
      // The Studio's kinds go through its one catch-all route: checked below.
      if (rename?.route.startsWith('studio/')) continue
      if (rename) {
        expect(existsSync(routeFile(rename.route)), `${id} rename route`).toBe(true)
        expect(exportsVerb(rename.route, 'PATCH'), `${id} rename PATCH`).toBe(true)
      }
      if (archive.kind !== 'none') {
        expect(existsSync(routeFile(archive.route)), `${id} archive route`).toBe(true)
        // Restore (and a flag's archive) is always a PATCH.
        expect(exportsVerb(archive.route, 'PATCH'), `${id} archive PATCH`).toBe(true)
        if (archive.kind === 'status' && archive.via === 'delete') expect(exportsVerb(archive.route, 'DELETE'), `${id} archive DELETE`).toBe(true)
      }
    }
  })

  it("the Studio's kinds name its own routes (the catch-all and the Studio router), with the verbs sent", () => {
    const catchAll = readFileSync(join(API, 'studio', '[...path]', 'route.ts'), 'utf8')
    const routesDir = join(__dirname, '../../studio/server/routes')
    const routes = ['videos.ts', 'projects.ts'].map((f) => readFileSync(join(routesDir, f), 'utf8')).join('\n')
    const studioRoute = (verb: string, path: string) => new RegExp(`route\\('${verb}', '${path}'`).test(routes)
    for (const id of ['studio_video', 'studio_project'] as const) {
      const { rename, archive } = ENTITY_ACTIONS[id]
      expect(rename?.route.startsWith('studio/'), id).toBe(true)
      expect(catchAll, 'the catch-all takes PATCH').toMatch(/handle as PATCH/)
      expect(studioRoute('PATCH', `${rename!.route.slice('studio/'.length)}/:id`), `${id} rename PATCH`).toBe(true)
      if (archive.kind === 'status') {
        const path = `${archive.route.slice('studio/'.length)}/:id`
        expect(studioRoute('PATCH', path), `${id} restore PATCH`).toBe(true)
        if (archive.via === 'delete') expect(studioRoute('DELETE', path), `${id} archive DELETE`).toBe(true)
      }
    }
  })

  it("the kinds that open as a record card are exactly the card's record types", () => {
    const record = ids.filter((id) => ENTITY_ACTIONS[id].open === 'record').sort()
    expect(record).toEqual([...CARD_RECORD_TYPES].sort())
  })

  it('every kind with an open opens a card, and every one without opens none', () => {
    for (const id of ids) {
      const target = entityOpenTarget(id, '00000000-0000-4000-8000-000000000001', 'A record')
      if (ENTITY_ACTIONS[id].open === null) expect(target, id).toBeNull()
      else expect(target && cardForTarget(target), id).toBeTruthy()
    }
  })

  it('shares and makes tasks only for kinds a mention may name', () => {
    for (const id of ids) {
      const d = ENTITY_ACTIONS[id]
      if (d.share) expect(isMentionableType(id) && d.open !== null, `${id} share`).toBe(true)
      if (d.makeTask) expect(isMentionableType(id), `${id} makeTask`).toBe(true)
    }
  })
})

describe('deep links', () => {
  it("links the Studio's kinds as the Studio page on them (the places PAGE_DEEP_LINK_PLACES reads)", () => {
    const id = '00000000-0000-4000-8000-0000000000aa'
    expect(entityLink('studio_video', id, 'https://app.example/')).toBe(`https://app.example/account?page=studio&video=${id}`)
    expect(entityLink('studio_project', id, 'https://app.example')).toBe(`https://app.example/account?page=studio&studio_project=${id}`)
    expect(PAGE_DEEP_LINK_PLACES.studio).toEqual(Object.fromEntries(Object.entries(STUDIO_PAGE_LINKS).map(([kind, param]) => [param, kind])))
    expect(`https://app.example${studioVideoLink(id)}`).toBe(entityLink('studio_video', id, 'https://app.example'))
    expect(entityOpenTarget('studio_video', id, 'Launch teaser')).toEqual({ type: 'studio_video', id, title: 'Launch teaser' })
  })

  it('keeps every link the app already handed out', () => {
    for (const t of ['sequence', 'prospect_list', 'action', 'project', 'initiative'] as const) expect(DEEP_LINK_TYPES).toContain(t)
  })

  it('links only kinds whose param opens their card', () => {
    for (const t of DEEP_LINK_TYPES) {
      const target = entityOpenTarget(t, '00000000-0000-4000-8000-000000000001')
      // A team chat message opens team chat on it (migration 560), not a card of its own.
      const opens = target?.type === 'team_chat' ? (target.messageId ? 'team_chat_message' : null) : target && 'id' in target && target.type
      expect(opens, t).toBe(t)
    }
  })

  it('builds the boot deep link, and none for a kind without one', () => {
    expect(entityLink('document', 'doc-1', 'https://app.example.test/')).toBe('https://app.example.test/account?document=doc-1')
    expect(entityLink('calendar_event', 'ev-1', 'https://app.example.test')).toBeNull()
    expect(entityLink('claim', 'c-1', 'https://app.example.test')).toBeNull()
  })

  it('copies an id as "<kind> <uuid>"', () => {
    expect(entityIdText('capture', 'c-1')).toBe('capture c-1')
  })
})

describe('supportedEntityActions', () => {
  it('a kind without an archive hides Archive and Restore', () => {
    for (const id of ids) {
      if (ENTITY_ACTIONS[id].archive.kind !== 'none') continue
      for (const archived of [false, true]) {
        const actions = supportedEntityActions(id, { archived })
        expect(actions, id).not.toContain('archive')
        expect(actions, id).not.toContain('restore')
      }
    }
    expect(supportedEntityActions('contact')).not.toContain('archive')
  })

  it('offers Archive, or Restore once archived, for a kind that archives', () => {
    expect(supportedEntityActions('document')).toContain('archive')
    expect(supportedEntityActions('document', { archived: true })).toEqual(expect.arrayContaining(['restore']))
    expect(supportedEntityActions('document', { archived: true })).not.toContain('archive')
  })

  it('lists a record kind\'s full menu, in order', () => {
    expect(supportedEntityActions('document')).toEqual(['open', 'copy_link', 'copy_id', 'rename', 'share', 'make_task', 'archive'])
  })

  it('hides what a kind does not support', () => {
    // A calendar event: private, renamed at its provider, no link.
    expect(supportedEntityActions('calendar_event')).toEqual(['open', 'copy_id', 'make_task'])
    // A task is not made from a task.
    expect(supportedEntityActions('action')).not.toContain('make_task')
    // A part of something else: only its id.
    expect(supportedEntityActions('comment')).toEqual(['copy_id'])
  })

  it('offers no Open where no chat can open a card', () => {
    expect(supportedEntityActions('company', { canOpen: false })).not.toContain('open')
  })

  it('offers nothing for a kind that is not registered', () => {
    expect(supportedEntityActions('not_a_kind')).toEqual([])
  })
})

describe('isArchivedRow', () => {
  it("reads each kind's own archive", () => {
    expect(isArchivedRow('document', { status: 'archived' })).toBe(true)
    expect(isArchivedRow('document', { status: 'active' })).toBe(false)
    expect(isArchivedRow('project', { is_archived: true })).toBe(true)
    expect(isArchivedRow('initiative', { status: 'archived' })).toBe(true)
    expect(isArchivedRow('contact', { status: 'archived' })).toBe(false)
    expect(isArchivedRow('document', null)).toBe(false)
  })
})
