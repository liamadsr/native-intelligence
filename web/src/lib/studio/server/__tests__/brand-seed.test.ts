/**
 * A new Studio project's brand starts from the workspace and nothing invented (brand-seed.ts): the workspace's name,
 * and its logo's link (https only) in the notes; a workspace that can't be read seeds nothing and refuses nothing.
 * Over the in-memory tables; a made-up workspace.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject, projectSummary } from '../projects'
import { logoLink, seedFromWorkspace } from '../brand-seed'
import { fakeContext, WS } from './fake'

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('seeding a project from the workspace', () => {
  it('keeps only an https logo link of a sane length', () => {
    expect(logoLink('https://cdn.example/fernhill/logo.png')).toBe('https://cdn.example/fernhill/logo.png')
    expect(logoLink('http://cdn.example/logo.png')).toBeNull()
    expect(logoLink('data:image/png;base64,AAAA')).toBeNull()
    expect(logoLink(`https://cdn.example/${'a'.repeat(1200)}`)).toBeNull()
    expect(logoLink(null)).toBeNull()
  })

  it('reads the name and the logo, and nothing else', () => {
    expect(seedFromWorkspace({ name: '  Fernhill Studio ', logo_url: 'https://cdn.example/logo.png' })).toEqual({
      brand: { name: 'Fernhill Studio' },
      notes: 'Logo (from the workspace): https://cdn.example/logo.png',
    })
    expect(seedFromWorkspace({ name: '', logo_url: null })).toEqual({ brand: null, notes: null })
    expect(seedFromWorkspace(null)).toEqual({ brand: null, notes: null })
  })

  it('a new project carries the workspace name as its brand and the logo link in its notes', async () => {
    const env = fakeContext({ workspace: [{ id: WS, name: 'Fernhill Studio', logo_url: 'https://cdn.example/logo.png' }] })
    const made = await createProject(env.ctx, 'Spring launch')
    expect(made.brand).toEqual({ name: 'Fernhill Studio' })
    expect(made.notes).toBe('Logo (from the workspace): https://cdn.example/logo.png')
    expect((await projectSummary(env.ctx, made.id)).brand).toEqual({ name: 'Fernhill Studio' })
  })

  it('a workspace with nothing to give (or none to read) makes a project with an empty brand', async () => {
    const env = fakeContext({ workspace: [{ id: WS, name: '', logo_url: null }] })
    const made = await createProject(env.ctx, 'Spring launch')
    expect(made.brand ?? null).toBeNull()
    expect(made.notes ?? null).toBeNull()
    const none = fakeContext()
    expect((await createProject(none.ctx, 'Autumn')).title).toBe('Autumn')
  })
})
