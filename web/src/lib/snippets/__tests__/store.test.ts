import { describe, expect, it } from 'vitest'
import { createSnippet, deleteSnippet, getSnippet, listSnippets, updateSnippet } from '../store'
import { ADMIN, M_ADMIN, M_OTHER, ME, OTHER, WS, snippetDb, snippetRow } from './helpers/snippet-db'

const me = { workspaceId: WS, userId: ME }
const other = { workspaceId: WS, userId: OTHER }
const admin = { workspaceId: WS, userId: ADMIN }

describe('snippet store', () => {
  it('lists your own and the shared ones, never another person’s personal one', async () => {
    const db = snippetDb({
      snippet: [
        snippetRow({ shortcut: 'mine' }),
        snippetRow({ shortcut: 'theirs', created_by: M_OTHER }),
        snippetRow({ shortcut: 'team', created_by: M_OTHER, visibility: 'workspace' }),
        snippetRow({ shortcut: 'elsewhere', workspace_id: 'other-ws', visibility: 'workspace' }),
      ],
    })
    const r = await listSnippets(db.client, me)
    expect(r.ok && r.value.map((s) => s.shortcut)).toEqual(['mine', 'team'])
    const shared = await listSnippets(db.client, me, { sharedOnly: true })
    expect(shared.ok && shared.value.map((s) => s.shortcut)).toEqual(['team'])
    expect(r.ok && r.value.find((s) => s.shortcut === 'team')).toMatchObject({ mine: false, canEdit: false })
  })

  it('refuses a caller who is not a member', async () => {
    const db = snippetDb()
    expect(await listSnippets(db.client, { workspaceId: WS, userId: 'stranger' })).toMatchObject({ ok: false, status: 403 })
  })

  it('creates as the caller, and refuses a taken shortcut', async () => {
    const db = snippetDb()
    const made = await createSnippet(db.client, me, { name: 'Sig', shortcut: 'Sig', body: 'Best' })
    expect(made).toMatchObject({ ok: true, value: { shortcut: 'sig', visibility: 'personal', mine: true } })
    expect(db.tables.snippet[0]).toMatchObject({ created_by: 'member-me', workspace_id: WS })
    expect(await createSnippet(db.client, me, { name: 'Again', shortcut: 'sig', body: 'x' })).toMatchObject({ ok: false, status: 409 })
    // Another person's personal ;sig and a shared ;sig are fine.
    expect(await createSnippet(db.client, other, { name: 'Sig', shortcut: 'sig', body: 'y' })).toMatchObject({ ok: true })
    expect(await createSnippet(db.client, other, { name: 'Team', shortcut: 'sig', body: 'z', visibility: 'workspace' })).toMatchObject({ ok: true })
    expect(await createSnippet(db.client, me, { name: 'Team2', shortcut: 'sig', body: 'z', visibility: 'workspace' })).toMatchObject({ ok: false, status: 409 })
  })

  it('a shared one is changed by its maker or an admin; only its maker changes who sees it', async () => {
    const row = snippetRow({ shortcut: 'team', created_by: M_OTHER, visibility: 'workspace' })
    const db = snippetDb({ snippet: [row] })
    expect(await updateSnippet(db.client, me, String(row.id), { body: 'nope' })).toMatchObject({ ok: false, status: 403 })
    expect(await updateSnippet(db.client, admin, String(row.id), { body: 'Admin words' })).toMatchObject({ ok: true, value: { body: 'Admin words', canEdit: true, mine: false } })
    expect(await updateSnippet(db.client, admin, String(row.id), { visibility: 'personal' })).toMatchObject({ ok: false, status: 403 })
    expect(await updateSnippet(db.client, other, String(row.id), { visibility: 'personal' })).toMatchObject({ ok: true, value: { visibility: 'personal' } })
    // Now personal to its maker: out of everyone else's reach.
    expect(await getSnippet(db.client, admin, { id: String(row.id) })).toMatchObject({ ok: false, status: 404 })
    expect(row.created_by).toBe(M_OTHER)
    void M_ADMIN
  })

  it('another person’s personal snippet cannot be read, changed or deleted', async () => {
    const row = snippetRow({ created_by: M_OTHER })
    const db = snippetDb({ snippet: [row] })
    expect(await getSnippet(db.client, me, { id: String(row.id) })).toMatchObject({ ok: false, status: 404 })
    expect(await updateSnippet(db.client, me, String(row.id), { body: 'x' })).toMatchObject({ ok: false, status: 404 })
    expect(await deleteSnippet(db.client, me, String(row.id))).toMatchObject({ ok: false, status: 404 })
    expect(await deleteSnippet(db.client, admin, String(row.id))).toMatchObject({ ok: false, status: 404 })
    expect(db.tables.snippet).toHaveLength(1)
  })

  it('reads by shortcut, your personal one first', async () => {
    const db = snippetDb({
      snippet: [snippetRow({ shortcut: 'sig', created_by: M_OTHER, visibility: 'workspace', name: 'Team' }), snippetRow({ shortcut: 'sig', name: 'Mine' })],
    })
    expect(await getSnippet(db.client, me, { shortcut: ';SIG' })).toMatchObject({ ok: true, value: { name: 'Mine' } })
    expect(await getSnippet(db.client, me, { shortcut: 'sig' }, { sharedOnly: true })).toMatchObject({ ok: true, value: { name: 'Team' } })
    expect(await getSnippet(db.client, me, { shortcut: 'nope' })).toMatchObject({ ok: false, status: 404 })
  })

  it('a visibility flip into a taken shortcut says so in words', async () => {
    const mine = snippetRow({ shortcut: 'intro' })
    const shared = snippetRow({ shortcut: 'intro', created_by: M_OTHER, visibility: 'workspace' })
    const db = snippetDb({ snippet: [mine, shared] })
    expect(await updateSnippet(db.client, me, String(mine.id), { visibility: 'workspace' })).toEqual({
      ok: false,
      status: 409,
      error: 'The workspace already has a shared snippet ;intro.',
    })
    expect(await updateSnippet(db.client, other, String(shared.id), { visibility: 'personal' })).toMatchObject({ ok: true })
    // Now Bob's personal ;intro; Alice makes hers shared, then Bob can't make his shared again.
    expect(await updateSnippet(db.client, me, String(mine.id), { visibility: 'workspace' })).toMatchObject({ ok: true })
    const own = snippetRow({ shortcut: 'intro', created_by: M_OTHER })
    db.tables.snippet.push(own)
    expect(await updateSnippet(db.client, other, String(shared.id), { visibility: 'workspace' })).toMatchObject({ ok: false, status: 409 })
    expect(await updateSnippet(db.client, me, String(mine.id), { visibility: 'personal', shortcut: 'intro' })).toMatchObject({ ok: true })
    expect(await createSnippet(db.client, me, { name: 'Again', shortcut: 'intro', body: 'x' })).toEqual({ ok: false, status: 409, error: 'You already have a snippet ;intro.' })
  })

  it('deletes your own', async () => {
    const row = snippetRow()
    const db = snippetDb({ snippet: [row] })
    expect(await deleteSnippet(db.client, me, String(row.id))).toEqual({ ok: true, value: { deleted: true } })
    expect(db.tables.snippet).toHaveLength(0)
  })
})
