/**
 * The website tools (roadmap track E, src/lib/ai/tools/website.ts): their
 * registry classes, that the ones which open a pull request are exactly the
 * text-hold exemptions, and that nobody-there turns never start a change.
 * The flow itself is covered in src/lib/website/__tests__/flow.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/oauth/github-token', () => ({ storedGithubToken: vi.fn(async () => null) }))
const start = vi.hoisted(() => ({ connectWebsite: vi.fn(), startWiring: vi.fn(), startEdit: vi.fn(), startUndo: vi.fn() }))
vi.mock('@/lib/website/start', () => start)

import { getToolSideEffect } from '@/lib/ai/tool-registry'
import { createWebsiteTools, WEBSITE_PREPARE_TOOLS, WEBSITE_TOOL_NAMES } from '../tools/website'

const run = (tools: ReturnType<typeof createWebsiteTools>, name: keyof ReturnType<typeof createWebsiteTools>, input: unknown) =>
  (tools[name] as unknown as { execute: (input: unknown, opts: unknown) => Promise<Record<string, unknown>> }).execute(input, {})

describe('the website tools', () => {
  it('are classed: a read, an internal write, and three automation writes that only open a pull request', () => {
    expect(WEBSITE_TOOL_NAMES.map((n) => [n, getToolSideEffect(n)])).toEqual([
      ['list_website_repos', 'read'],
      ['connect_website', 'internal-write'],
      ['wire_website_form', 'automation-write'],
      ['change_website', 'automation-write'],
      ['undo_website_change', 'automation-write'],
    ])
    expect([...WEBSITE_PREPARE_TOOLS].sort()).toEqual(['change_website', 'undo_website_change', 'wire_website_form'])
  })

  it('a turn nobody is in (a loop, a home turn) never connects or changes the site', async () => {
    const tools = createWebsiteTools('u1', {} as never, 'w1', { unattended: true })
    for (const [name, input] of [['connect_website', { repo: 'jane/site' }], ['wire_website_form', {}], ['change_website', { request: 'x' }], ['undo_website_change', {}]] as const) {
      expect(await run(tools, name, input)).toMatchObject({ success: false })
    }
    expect(start.connectWebsite).not.toHaveBeenCalled()
    expect(start.startWiring).not.toHaveBeenCalled()
    expect(start.startEdit).not.toHaveBeenCalled()
    expect(start.startUndo).not.toHaveBeenCalled()
  })

  it('listing repos without GitHub says to text a GitHub link', async () => {
    const tools = createWebsiteTools('u1', {} as never, 'w1')
    expect(await run(tools, 'list_website_repos', {})).toMatchObject({ success: false, code: 'NO_GITHUB' })
  })

  it('a site address that is no address is refused before connecting', async () => {
    const tools = createWebsiteTools('u1', {} as never, 'w1')
    expect(await run(tools, 'connect_website', { repo: 'jane/site', site_url: 'not a site' })).toMatchObject({ success: false })
    expect(start.connectWebsite).not.toHaveBeenCalled()
    start.connectWebsite.mockResolvedValue({ success: true })
    await run(tools, 'connect_website', { repo: 'jane/site', site_url: 'janescleaning.com' })
    expect(start.connectWebsite).toHaveBeenCalledWith({}, { userId: 'u1', workspaceId: 'w1' }, { repo: 'jane/site', siteUrl: 'https://janescleaning.com' }, undefined)
  })

  it("passes the owner's choices through: the form, and replacing what it does only when asked", async () => {
    const tools = createWebsiteTools('u1', {} as never, 'w1')
    start.startWiring.mockResolvedValue({ success: true })
    await run(tools, 'wire_website_form', {})
    expect(start.startWiring).toHaveBeenLastCalledWith({}, { userId: 'u1', workspaceId: 'w1' }, { formPath: null, replaceCurrent: false }, undefined)
    await run(tools, 'wire_website_form', { form_path: 'contact.html', replace_current: true })
    expect(start.startWiring).toHaveBeenLastCalledWith({}, { userId: 'u1', workspaceId: 'w1' }, { formPath: 'contact.html', replaceCurrent: true }, undefined)
  })
})
