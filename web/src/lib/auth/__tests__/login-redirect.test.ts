import { describe, expect, it } from 'vitest'
import { isInviteRedirectPath, isMcpTarget, mcpRedirectTarget, resolvePostAuthRedirect } from '../login-redirect'

const ORIGIN = 'https://dial8.ai'
const APP = 'https://dial8.ai'

describe('mcpRedirectTarget', () => {
  it('resumes the MCP authorize step from a path or a full URL on this origin, as a path and search', () => {
    expect(mcpRedirectTarget('/api/mcp/oauth/authorize?client_id=x&state=y', ORIGIN, APP)).toBe('/api/mcp/oauth/authorize?client_id=x&state=y')
    expect(mcpRedirectTarget('https://dial8.ai/api/mcp/oauth/authorize?client_id=x', ORIGIN, APP)).toBe('/api/mcp/oauth/authorize?client_id=x')
    expect(mcpRedirectTarget('/mcp/authorize?client_id=x', ORIGIN, APP)).toBe('/mcp/authorize?client_id=x')
  })

  it("trusts the app's configured origin too (the authorize route links back from it)", () => {
    expect(mcpRedirectTarget('http://localhost:3000/api/mcp/oauth/authorize?x=1', 'http://127.0.0.1:3000', 'http://localhost:3000')).toBe('/api/mcp/oauth/authorize?x=1')
  })

  it('never names another site, or anything outside the MCP paths', () => {
    for (const evil of [
      'https://evil.example/api/mcp/x',
      '//evil.example/api/mcp/x',
      '/\\evil.example/api/mcp/x',
      'http://dial8.ai/api/mcp/x',
      'https://dial8.ai.evil.example/mcp/x',
      'https://dial8.ai@evil.example/api/mcp/x',
      'javascript:alert(1)//api/mcp/',
      '/api/mcp/../../account/settings',
      '/somewhere-else',
    ]) {
      expect(mcpRedirectTarget(evil, ORIGIN, APP), evil).toBeNull()
    }
  })
})

describe('resolvePostAuthRedirect (a password sign-in)', () => {
  it('resumes the MCP authorize step (it used to drop it on /account)', () => {
    const target = resolvePostAuthRedirect('https://dial8.ai/api/mcp/oauth/authorize?client_id=x', ORIGIN)
    expect(target).toBe('/api/mcp/oauth/authorize?client_id=x')
    expect(isMcpTarget(target)).toBe(true)
  })

  it('keeps the invite, share and in-app targets, and refuses everything else', () => {
    expect(resolvePostAuthRedirect(null, ORIGIN)).toBe('/account')
    expect(resolvePostAuthRedirect('/invite/tok', ORIGIN)).toBe('/invite/tok')
    expect(resolvePostAuthRedirect('/s/abc', ORIGIN)).toBe('/s/abc')
    expect(resolvePostAuthRedirect('/account/settings', ORIGIN)).toBe('/account/settings')
    expect(isMcpTarget('/account/settings')).toBe(false)
    for (const evil of ['//evil.example/account', 'https://evil.example/api/mcp/x', '/somewhere-else', '/invite//evil.example', '/link//evil.example']) {
      expect(resolvePostAuthRedirect(evil, ORIGIN), evil).toBe('/account')
    }
  })

  it("keeps an agent link's connect link, so a new account lands back on the request", () => {
    expect(resolvePostAuthRedirect('/link/abc', ORIGIN)).toBe('/link/abc')
    expect(isInviteRedirectPath('/link/abc')).toBe(true)
    expect(isInviteRedirectPath('/invite/tok')).toBe(true)
    for (const no of ['/linkx/abc', '/link//evil.example', 'https://evil.example/link/abc', '/s/abc']) expect(isInviteRedirectPath(no), no).toBe(false)
  })
})
