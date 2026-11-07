import { describe, it, expect } from 'vitest'
import { evaluateGuardrail, looksSensitive } from '../guardrails'

describe('browser agent guardrails', () => {
  const base = { blockedSites: [] as string[], targetUrl: null as string | null, requiresApproval: false }

  it('allows reads and writes on any site when nothing is blocked', () => {
    for (const command of ['read_page', 'get_text', 'screenshot', 'list_tabs', 'click', 'type', 'navigate']) {
      expect(evaluateGuardrail({ ...base, command, targetUrl: 'https://new-site.example/page' }))
        .toEqual({ allow: true, needsApproval: false })
    }
  })

  it('refuses reads on a blocked site too, naming the blocked entry', () => {
    for (const command of ['read_page', 'get_text', 'screenshot']) {
      const d = evaluateGuardrail({ ...base, command, targetUrl: 'https://www.linkedin.com/feed', blockedSites: ['linkedin.com'] })
      expect(d).toMatchObject({ allow: false, blockedSite: 'linkedin.com' })
    }
  })

  it('refuses writes on a blocked site and its subdomains', () => {
    for (const targetUrl of ['https://linkedin.com/', 'https://ca.linkedin.com/in/x', 'http://www.linkedin.com:8080/']) {
      const d = evaluateGuardrail({ ...base, command: 'click', targetUrl, blockedSites: ['linkedin.com'] })
      expect(d).toMatchObject({ allow: false, blockedSite: 'linkedin.com' })
    }
  })

  it('refuses navigating into a blocked site', () => {
    const d = evaluateGuardrail({ ...base, command: 'navigate', targetUrl: 'https://mail.google.com/mail', blockedSites: ['mail.google.com'] })
    expect(d).toMatchObject({ allow: false, blockedSite: 'mail.google.com' })
  })

  it('a blocked subdomain leaves its parent domain usable', () => {
    const d = evaluateGuardrail({ ...base, command: 'navigate', targetUrl: 'https://www.google.com/search?q=x', blockedSites: ['mail.google.com'] })
    expect(d).toEqual({ allow: true, needsApproval: false })
  })

  it('requires approval for a sensitive action on an allowed site', () => {
    const d = evaluateGuardrail({ ...base, command: 'click', targetUrl: 'https://shop.example.com', requiresApproval: true })
    expect(d).toMatchObject({ allow: true, needsApproval: true })
  })

  it('a blocked site wins over approval: it is refused, not asked', () => {
    const d = evaluateGuardrail({ ...base, command: 'click', targetUrl: 'https://linkedin.com', blockedSites: ['linkedin.com'], requiresApproval: true })
    expect(d.allow).toBe(false)
  })

  it('fails closed on an unknown command', () => {
    expect(evaluateGuardrail({ ...base, command: 'exfiltrate' }).allow).toBe(false)
  })

  it('a write on an unknown page is refused only while something is blocked', () => {
    expect(evaluateGuardrail({ ...base, command: 'click' })).toEqual({ allow: true, needsApproval: false })
    expect(evaluateGuardrail({ ...base, command: 'click', blockedSites: ['linkedin.com'] }).allow).toBe(false)
    // Reads are checked against the page they actually read instead.
    expect(evaluateGuardrail({ ...base, command: 'read_page', blockedSites: ['linkedin.com'] }).allow).toBe(true)
  })

  it('window commands touch no site', () => {
    expect(evaluateGuardrail({ ...base, command: 'open_window', blockedSites: ['linkedin.com'] }).allow).toBe(true)
  })

  it('looksSensitive flags buy/delete/send-style text', () => {
    expect(looksSensitive('Buy now')).toBe(true)
    expect(looksSensitive('Delete account')).toBe(true)
    expect(looksSensitive('Send message')).toBe(true)
    expect(looksSensitive('Read more')).toBe(false)
    expect(looksSensitive(null)).toBe(false)
    expect(looksSensitive(undefined)).toBe(false)
  })
})
