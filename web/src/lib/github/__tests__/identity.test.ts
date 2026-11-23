import { describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { githubUserOf, recordGithubIdentity } from '../identity'

describe('recordGithubIdentity', () => {
  it('keeps who the person is on GitHub, one of our people per GitHub account, the newest connection winning', async () => {
    const tables: Record<string, Array<Record<string, unknown>>> = { github_identity: [{ user_id: 'old-user', github_user_id: 101, login: 'dana' }] }
    const db = memoryDb(tables)
    expect(await recordGithubIdentity(db, 'u1', { id: 101, login: 'dana' })).toBe(true)
    expect(tables.github_identity).toEqual([expect.objectContaining({ user_id: 'u1', github_user_id: 101, login: 'dana' })])
    // A renamed login: the same row.
    expect(await recordGithubIdentity(db, 'u1', { id: 101, login: 'dana-x' })).toBe(true)
    expect(tables.github_identity).toEqual([expect.objectContaining({ user_id: 'u1', login: 'dana-x' })])
  })

  it('refuses anything that is not GitHub’s own shape', async () => {
    const tables: Record<string, Array<Record<string, unknown>>> = { github_identity: [] }
    const db = memoryDb(tables)
    for (const gh of [{ id: '101', login: 'dana' }, { id: -1, login: 'dana' }, { id: 1.5, login: 'dana' }, { id: 101, login: 'bad login' }, { id: 101, login: '@me' }, { id: 101, login: null }]) {
      expect(await recordGithubIdentity(db, 'u1', gh)).toBe(false)
    }
    expect(tables.github_identity).toEqual([])
  })
})

describe('githubUserOf', () => {
  it('asks GitHub with the token and reads its answer; null when it refuses', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ id: 101, login: 'dana' }), { status: 200 }))
    expect(await githubUserOf('tok', ok as unknown as typeof fetch)).toEqual({ id: 101, login: 'dana' })
    expect(((ok.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).Authorization).toBe('Bearer tok')
    const no = vi.fn(async () => new Response('', { status: 401 }))
    expect(await githubUserOf('tok', no as unknown as typeof fetch)).toBeNull()
  })
})
