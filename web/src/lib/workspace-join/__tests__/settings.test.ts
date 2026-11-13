/**
 * The switches and the link (settings.ts) on an in-memory database: the
 * link on, off, back on, reset; a closed link opens nothing; the domain
 * claim clash; the token's strength.
 */
import { describe, expect, it } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import {
  findOpenJoinLink,
  readJoinSettings,
  readMembersCanInvite,
  resetJoinLink,
  setAutoJoinDomain,
  setJoinLinkEnabled,
  setMembersCanInvite,
} from '../settings'
import { isJoinTokenShape, joinLinkPath, newJoinToken } from '../token'

type Row = Record<string, unknown>

function setup() {
  const tables: Record<string, Row[]> = { workspace_join_settings: [], workspace_join_link: [] }
  const db = memoryDb(tables, {
    workspace_join_settings: (a, b) =>
      a.workspace_id !== b.workspace_id && a.auto_join_domain != null && a.auto_join_domain === b.auto_join_domain,
    workspace_join_link: (a, b) => a.workspace_id !== b.workspace_id && a.token === b.token,
  })
  return { db, tables }
}

describe('the token', () => {
  it('is 256 bits of url-safe base64, different every time', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newJoinToken()))
    expect(tokens.size).toBe(200)
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(isJoinTokenShape(t)).toBe(true)
    }
    expect(joinLinkPath('abc')).toBe('/join/abc')
  })

  it('a path segment that cannot be a token is refused before any lookup', () => {
    for (const bad of ['', 'short', 'a'.repeat(129), 'aaaaaaaaaaaaaaaaaaaaaaaa/', "aaaaaaaaaaaaaaaaaaaaaa'--", null, 42]) {
      expect(isJoinTokenShape(bad), String(bad)).toBe(false)
    }
  })
})

describe('the link', () => {
  it('starts off: no row, nothing open', async () => {
    const { db } = setup()
    expect(await readJoinSettings(db, 'ws-acme')).toEqual({ membersCanInvite: false, autoJoinDomain: null, link: null })
    expect(await setJoinLinkEnabled(db, 'ws-acme', false, 'user-avery')).toBeNull()
  })

  it('on makes a token and opens it; off closes it; on again brings the same link back', async () => {
    const { db } = setup()
    const on = await setJoinLinkEnabled(db, 'ws-acme', true, 'user-avery')
    expect(on).toMatchObject({ enabled: true })
    expect(isJoinTokenShape(on!.token)).toBe(true)
    expect(await findOpenJoinLink(db, on!.token)).toEqual({ workspaceId: 'ws-acme' })

    await setJoinLinkEnabled(db, 'ws-acme', false, 'user-avery')
    expect(await findOpenJoinLink(db, on!.token)).toBeNull()

    const again = await setJoinLinkEnabled(db, 'ws-acme', true, 'user-avery')
    expect(again!.token).toBe(on!.token)
    expect(await findOpenJoinLink(db, on!.token)).toEqual({ workspaceId: 'ws-acme' })
  })

  it('reset kills the old token at once and keeps the link on', async () => {
    const { db } = setup()
    const before = await setJoinLinkEnabled(db, 'ws-acme', true, 'user-avery')
    const after = await resetJoinLink(db, 'ws-acme', 'user-avery')
    expect(after.token).not.toBe(before!.token)
    expect(after.enabled).toBe(true)
    expect(await findOpenJoinLink(db, before!.token)).toBeNull()
    expect(await findOpenJoinLink(db, after.token)).toEqual({ workspaceId: 'ws-acme' })
  })

  it('an unknown token opens nothing', async () => {
    const { db } = setup()
    await setJoinLinkEnabled(db, 'ws-acme', true, 'user-avery')
    expect(await findOpenJoinLink(db, newJoinToken())).toBeNull()
  })
})

describe('the switches', () => {
  it('members can invite: off until switched on', async () => {
    const { db } = setup()
    expect(await readMembersCanInvite(db, 'ws-acme')).toBe(false)
    await setMembersCanInvite(db, 'ws-acme', true, 'user-avery')
    expect(await readMembersCanInvite(db, 'ws-acme')).toBe(true)
    await setMembersCanInvite(db, 'ws-acme', false, 'user-avery')
    expect(await readMembersCanInvite(db, 'ws-acme')).toBe(false)
  })

  it('a domain is claimed by one workspace at a time; releasing it frees it', async () => {
    const { db } = setup()
    expect(await setAutoJoinDomain(db, 'ws-acme', 'acme.example', 'user-avery')).toEqual({ ok: true })
    expect(await setAutoJoinDomain(db, 'ws-northwind', 'acme.example', 'user-jordan')).toEqual({ ok: false, clash: true })
    expect((await readJoinSettings(db, 'ws-northwind')).autoJoinDomain).toBeNull()

    expect(await setAutoJoinDomain(db, 'ws-acme', null, 'user-avery')).toEqual({ ok: true })
    expect(await setAutoJoinDomain(db, 'ws-northwind', 'acme.example', 'user-jordan')).toEqual({ ok: true })
  })

  it('switching the domain does not touch members can invite, and the other way round', async () => {
    const { db } = setup()
    await setMembersCanInvite(db, 'ws-acme', true, 'user-avery')
    await setAutoJoinDomain(db, 'ws-acme', 'acme.example', 'user-avery')
    expect(await readJoinSettings(db, 'ws-acme')).toMatchObject({ membersCanInvite: true, autoJoinDomain: 'acme.example' })
  })
})
