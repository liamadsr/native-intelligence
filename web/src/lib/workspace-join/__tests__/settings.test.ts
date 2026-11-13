/**
 * The switches, listed domains and the link (settings.ts) on an in-memory
 * database: the link on, off, back on, reset, two admins switching it on at
 * once; a closed link opens nothing; several domains per workspace and the
 * same domain in several workspaces; the token's strength.
 */
import { describe, expect, it } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import {
  addJoinDomain,
  findOpenJoinLink,
  readJoinSettings,
  readMembersCanInvite,
  removeJoinDomains,
  resetJoinLink,
  setJoinLinkEnabled,
  setMembersCanInvite,
} from '../settings'
import { isJoinTokenShape, joinLinkPath, newJoinToken } from '../token'

type Row = Record<string, unknown>

function setup() {
  const tables: Record<string, Row[]> = { workspace_join_settings: [], workspace_join_link: [], workspace_join_domain: [] }
  const db = memoryDb(tables, {
    workspace_join_link: (a, b) => a.workspace_id === b.workspace_id || a.token === b.token,
    workspace_join_domain: (a, b) => a.workspace_id === b.workspace_id && a.domain === b.domain,
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
    expect(await readJoinSettings(db, 'ws-acme')).toEqual({ membersCanInvite: false, domains: [], link: null })
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

  it('two admins switching it on at once both succeed, with one token', async () => {
    const { db, tables } = setup()
    const [a, b] = await Promise.all([
      setJoinLinkEnabled(db, 'ws-acme', true, 'user-avery'),
      setJoinLinkEnabled(db, 'ws-acme', true, 'user-jordan'),
    ])
    expect(tables.workspace_join_link).toHaveLength(1)
    expect(a!.token).toBe(b!.token)
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

  it('a workspace lists several domains; the same domain may be listed by several workspaces', async () => {
    const { db } = setup()
    await addJoinDomain(db, 'ws-acme', 'acme.example', 'user-avery')
    await addJoinDomain(db, 'ws-acme', 'acme-labs.example', 'user-jordan')
    await addJoinDomain(db, 'ws-acme', 'acme.example', 'user-jordan') // again: no change, no error
    await addJoinDomain(db, 'ws-northwind', 'acme.example', 'user-kai')
    expect((await readJoinSettings(db, 'ws-acme')).domains).toEqual(['acme-labs.example', 'acme.example'])
    expect((await readJoinSettings(db, 'ws-northwind')).domains).toEqual(['acme.example'])

    await removeJoinDomains(db, 'ws-acme', ['acme.example'])
    expect((await readJoinSettings(db, 'ws-acme')).domains).toEqual(['acme-labs.example'])
    expect((await readJoinSettings(db, 'ws-northwind')).domains).toEqual(['acme.example'])
  })

  it('the domains do not touch members can invite, and the other way round', async () => {
    const { db } = setup()
    await setMembersCanInvite(db, 'ws-acme', true, 'user-avery')
    await addJoinDomain(db, 'ws-acme', 'acme.example', 'user-avery')
    expect(await readJoinSettings(db, 'ws-acme')).toMatchObject({ membersCanInvite: true, domains: ['acme.example'] })
  })
})
