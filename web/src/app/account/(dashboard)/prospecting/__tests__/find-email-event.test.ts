// @vitest-environment jsdom
/**
 * The contact panel → Find-email handoff event.
 *
 * The contact detail panel owns no chat, so the button dispatches a window
 * event that dashboard-shell forwards to the active tab's ChatPanel — the same
 * shape as the prospecting pair beside it in start-event.ts. This module owns
 * the name, the payload and the dispatcher; these tests pin all three.
 *
 * The seeded text is pinned here as well as in the panel test because it is a
 * CONTRACT WITH THE SKILL: migration 263's prompt keys off "The user clicked
 * Find email" to decide it may save the address without asking again. Reword
 * the seed and the skill silently drops back to present-and-offer, which is the
 * wrong behaviour for a button — and nothing else would catch it.
 */
import { describe, it, expect } from 'vitest'
import {
  FIND_CONTACT_EMAIL_EVENT,
  FIND_EMAIL_SKILL_SLUG,
  STICKY_SKILL_SLUGS,
  buildFindEmailSeedText,
  startFindContactEmail,
  type FindContactEmailContext,
} from '../start-event'

const FULL: FindContactEmailContext = {
  contactId: 'ct-1',
  contactName: 'Ada Lovelace',
  jobTitle: 'CTO',
  companyName: 'Acme',
  companyDomain: 'acme.com',
  linkedinUrl: 'https://linkedin.com/in/ada',
}

describe('startFindContactEmail', () => {
  it('dispatches the named event carrying the detail verbatim', () => {
    const seen: FindContactEmailContext[] = []
    const listener = (e: Event) => seen.push((e as CustomEvent).detail)
    window.addEventListener(FIND_CONTACT_EMAIL_EVENT, listener)
    try {
      startFindContactEmail(FULL)
    } finally {
      window.removeEventListener(FIND_CONTACT_EMAIL_EVENT, listener)
    }
    expect(seen).toEqual([FULL])
  })

  it('the event name is the one the shell listens for', () => {
    expect(FIND_CONTACT_EMAIL_EVENT).toBe('dial8:find-contact-email')
  })

  it('the skill slug matches the system skill migration 263 seeds', () => {
    expect(FIND_EMAIL_SKILL_SLUG).toBe('find-email')
  })

  it('is NOT sticky — finding one address is one turn of work', () => {
    // Scout stays armed across turns because it is a conversation. This is a
    // button: leaving the chip on would put the user's next unrelated question
    // inside a two-category allowlist.
    expect(STICKY_SKILL_SLUGS.has(FIND_EMAIL_SKILL_SLUG)).toBe(false)
  })
})

describe('buildFindEmailSeedText', () => {
  it('opens with the clause the skill treats as authorization to save', () => {
    expect(buildFindEmailSeedText(FULL)).toContain('The user clicked Find email')
    expect(buildFindEmailSeedText(FULL)).toContain('save it to the contact')
  })

  it('carries the contact_id so the skill never guesses which row it is on', () => {
    expect(buildFindEmailSeedText(FULL)).toContain('(contact_id ct-1)')
  })

  it('names every anchor it was given', () => {
    const text = buildFindEmailSeedText(FULL)
    expect(text).toBe(
      'The user clicked Find email on the contact Ada Lovelace (contact_id ct-1), CTO at Acme (acme.com); ' +
        'LinkedIn https://linkedin.com/in/ada. Find their work email and save it to the contact.',
    )
  })

  it('omits what is missing rather than telling the model a blank is a fact', () => {
    const text = buildFindEmailSeedText({ contactId: 'ct-2', contactName: 'Grace Hopper' })
    expect(text).toBe(
      'The user clicked Find email on the contact Grace Hopper (contact_id ct-2). ' +
        'Find their work email and save it to the contact.',
    )
    // No "unknown", no dangling separators — a thin CRM row is normal.
    expect(text).not.toMatch(/unknown|null|undefined/)
  })

  it('normalises a pasted company URL to a bare host', () => {
    const text = buildFindEmailSeedText({
      contactId: 'ct-3',
      contactName: 'Ada',
      companyName: 'Acme',
      companyDomain: 'https://Acme.com/pricing',
    })
    expect(text).toContain('at Acme (acme.com)')
  })

  it('tolerates a company with a name but no domain', () => {
    const text = buildFindEmailSeedText({
      contactId: 'ct-4',
      contactName: 'Ada',
      companyName: 'Acme',
      companyDomain: null,
    })
    expect(text).toContain('at Acme.')
    expect(text).not.toContain('()')
  })
})
