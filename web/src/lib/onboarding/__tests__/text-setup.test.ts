import { describe, expect, it, vi } from 'vitest'
import { TEXT_SETUP_SECTION_KEY, TEXT_SETUP_WINDOW_MS, finishTextSetup, renderTextSetupSection, textSetupForChatSpec, textSetupFrom } from '../text-setup'
import { filterDb } from '@/test/filter-db'

/**
 * Setup by text: on for an owner who signed up by texting, until they confirm
 * their business (save_business_profile) or a month passes. It names where
 * they are and the steps; it never asks for a password.
 */
const T0 = Date.parse('2026-11-02T15:00:00Z')
const STARTED = { text_signup: { started_at: '2026-11-02T15:00:00.000Z' } }

describe('textSetupFrom', () => {
  it('on for a text sign-up not yet finished, within a month; the placeholder name is no name', () => {
    expect(textSetupFrom({ display_name: 'Owner', onboarding_progress: STARTED }, T0 + 1000)).toEqual({ startedAt: '2026-11-02T15:00:00.000Z', name: null })
    expect(textSetupFrom({ display_name: 'Jane', onboarding_progress: STARTED }, T0)).toMatchObject({ name: 'Jane' })
  })

  it('off when finished, past the window, or never a text sign-up (a web sign-up, a teammate)', () => {
    expect(textSetupFrom({ onboarding_progress: { text_signup: { ...STARTED.text_signup, finished_at: '2026-11-03T00:00:00Z' } } }, T0)).toBeNull()
    expect(textSetupFrom({ onboarding_progress: STARTED }, T0 + TEXT_SETUP_WINDOW_MS + 1)).toBeNull()
    expect(textSetupFrom({ onboarding_progress: { research: { status: 'done' } } }, T0)).toBeNull()
    expect(textSetupFrom({ onboarding_progress: null }, T0)).toBeNull()
    expect(textSetupFrom(null, T0)).toBeNull()
  })
})

describe('the section', () => {
  it('says where they are and the steps: link, website and research, only what is missing, a summary to confirm, then save', () => {
    const text = renderTextSetupSection({ startedAt: 'x', name: null }, { google: null, company: null })
    expect(text).toContain('Where they are: Google not connected. Their company: not researched yet.')
    for (const words of ['connect_link', 'research_my_company', 'web_fetch', 'service', 'pickup days', 'prices', 'summary', 'save_business_profile']) expect(text).toContain(words)
    expect(text).toContain('Never ask for a password')
    const later = renderTextSetupSection({ startedAt: 'x', name: 'Jane' }, { google: 'jane@brightweave.com', company: { name: 'Bright Weave', domain: 'brightweave.com' } })
    expect(later).toContain('Setup by text: Jane signed up')
    expect(later).toContain('Google connected (jane@brightweave.com). Their company: researched (Bright Weave, brightweave.com).')
  })

  it('reads the member row and the status for a text sign-up; none for a guest or anyone else; a failed read is held', async () => {
    const db = filterDb({
      member: [{ workspace_id: 'ws-1', user_id: 'user-1', display_name: 'Owner', onboarding_progress: STARTED }],
      connected_account: [{ user_id: 'user-1', provider: 'google', capability: 'email', is_enabled: true, account_email: 'jane@brightweave.com' }],
      company: [],
    })
    const spec = await textSetupForChatSpec(db, { workspaceId: 'ws-1', userId: 'user-1' })
    expect(spec.held).toBe(false)
    expect(spec.section?.key).toBe(TEXT_SETUP_SECTION_KEY)
    expect(spec.section?.markdown).toContain('Google connected (jane@brightweave.com)')
    expect(await textSetupForChatSpec(db, { workspaceId: 'ws-1', userId: 'user-1', guestId: 'g1' })).toEqual({ section: null, held: false })
    expect(await textSetupForChatSpec(db, { workspaceId: 'ws-1', userId: 'someone-else' })).toEqual({ section: null, held: false })
    const down = filterDb({ member: [] }, [], ['member'])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await textSetupForChatSpec(down, { workspaceId: 'ws-1', userId: 'user-1' })).toEqual({ section: null, held: true })
  })
})

describe('finishTextSetup', () => {
  it('writes the whole text_signup object back with finished_at (the merge is shallow); not set up is a no-op', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }))
    const db = Object.assign(filterDb({ member: [{ workspace_id: 'ws-1', user_id: 'user-1', onboarding_progress: STARTED }] }) as object, { rpc }) as never
    expect(await finishTextSetup(db, { workspaceId: 'ws-1', userId: 'user-1', nowMs: T0 })).toEqual({ success: true, ended: true })
    expect(rpc).toHaveBeenCalledWith('merge_onboarding_progress', {
      p_workspace_id: 'ws-1',
      p_patch: { text_signup: { started_at: '2026-11-02T15:00:00.000Z', finished_at: new Date(T0).toISOString() } },
      p_user_id: 'user-1',
    })
    const none = Object.assign(filterDb({ member: [{ workspace_id: 'ws-1', user_id: 'user-1', onboarding_progress: {} }] }) as object, { rpc: vi.fn() }) as never
    expect(await finishTextSetup(none, { workspaceId: 'ws-1', userId: 'user-1' })).toEqual({ success: true, ended: false })
  })
})

describe('the website step (roadmap track E)', () => {
  it('connects the site’s form when its code is on GitHub, approved by text, and never builds a new site', async () => {
    const { renderTextSetupSection, TEXT_SETUP_TOOLS } = await import('../text-setup')
    const text = renderTextSetupSection({ startedAt: '2026-11-02T15:00:00.000Z', name: 'Jane' }, { google: null, company: null })
    expect(text).toContain("5. Their website's form, so quote requests reach you: ask whether their site's code is on GitHub")
    expect(text).toContain('call connect_website')
    expect(text).toContain('wire_website_form')
    expect(text).toContain('Never build a new site.')
    expect(text).toContain('7. Once they confirm, call save_business_profile')
    expect(TEXT_SETUP_TOOLS).toEqual(expect.arrayContaining(['list_website_repos', 'connect_website', 'wire_website_form']))
  })
})
