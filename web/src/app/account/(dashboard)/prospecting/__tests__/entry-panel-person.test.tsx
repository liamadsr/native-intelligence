// @vitest-environment jsdom
/**
 * The PERSON entry panel (§10, Page 4).
 *
 * WHAT REPLACES THE FIT BLOCK is the point of this suite. Fit is scored on the
 * ACCOUNT, not on the person, so a letter grade beside someone's name would be
 * a number nobody computed. The question the panel has to answer is the one
 * the people stage actually risks getting wrong — is this the right person at
 * the right company? — and `identity_state` is that answer, stated with the
 * mechanism behind it rather than as a bare chip.
 *
 * Also pinned:
 *   - the research blob renders through the SAME Details vocabulary a company
 *     entry uses, because it is the same shape;
 *   - the parent account is a LINK, since `company_id` is NULL on a person by
 *     construction and the parent entry is the only route back;
 *   - Save is LIVE (phase 6, `createProspectContact`) with ONE gate: a
 *     `needs_review` person is confirmed IN THE PANEL before the write,
 *     because bulk save holds them back and this panel is where the evidence
 *     for that judgement is on screen.
 *   - Add-to-sequence is Save-then-enroll and is disabled with the reason when
 *     there is no email — which is most discovered people.
 *   - The Sequenced chip is derived, and says `exited` out loud.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { EntryPanel } from '../entry-panel'
import { entry } from './fixtures'
import type { ProspectListEntryRow } from '@/lib/prospecting/types'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function person(overrides: Partial<ProspectListEntryRow> = {}): ProspectListEntryRow {
  return entry({
    id: 'p1',
    kind: 'person',
    parent_entry_id: 'c1',
    candidate_key: 'linkedin.com/in/dana-reyes',
    candidate: {
      name: 'Dana Reyes',
      title: 'VP of Revenue Operations',
      domain: 'quillfort.ai',
      company_name: 'Quillfort Security',
      linkedin_url: 'linkedin.com/in/dana-reyes',
      email: null,
      one_liner: 'Runs the revenue operations function.',
      found_via: 'synthesized',
    },
    identity_state: 'anchored',
    ...overrides,
  })
}

const onSave = vi.fn()
const onDismiss = vi.fn()
const onOpenParent = vi.fn()

const onAddToSequence = vi.fn()

async function render(
  item: ProspectListEntryRow,
  props: {
    parentName?: string | null
    onAddToSequence?: () => void
    sequenced?: { status: 'active' | 'exited'; sequence_id: string; sequence_name: string } | null
  } = {},
) {
  onSave.mockReset()
  onDismiss.mockReset()
  onOpenParent.mockReset()
  onAddToSequence.mockReset()
  await act(async () => {
    root.render(
      <EntryPanel
        entry={item}
        onSave={onSave}
        onDismiss={onDismiss}
        onOpenParent={onOpenParent}
        onAddToSequence={onAddToSequence}
        {...props}
      />,
    )
  })
}

function text(): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  )
}

describe('EntryPanel — person', () => {
  it('renders identity, title, company and the missing email honestly', async () => {
    await render(person())
    const rendered = text()
    expect(rendered).toContain('Dana Reyes')
    expect(rendered).toContain('VP of Revenue Operations')
    expect(rendered).toContain('Quillfort Security')
    expect(rendered).toContain('No email found')
  })

  it('shows an email when there is one instead of the absence', async () => {
    await render(
      person({ candidate: { ...(person().candidate as object), email: 'dana@quillfort.ai' } }),
    )
    expect(text()).toContain('dana@quillfort.ai')
    expect(text()).not.toContain('No email found')
  })

  it('renders NO fit block — fit lives on the account', async () => {
    await render(person())
    expect(text()).not.toContain('Fit')
    expect(container.querySelector('[data-fit-tier]')).toBeNull()
  })

  it('explains an anchored identity by naming the domain it was confirmed on', async () => {
    await render(person())
    const rendered = text()
    expect(rendered).toContain('Verified at this company')
    expect(rendered).toContain('quillfort.ai')
    expect(rendered).toContain('namesake elsewhere could not land here')
  })

  it('explains needs_review as unproven, not as wrong', async () => {
    await render(person({ identity_state: 'needs_review' }))
    const rendered = text()
    expect(rendered).toContain('Employer not confirmed')
    expect(rendered).toContain('held back from bulk save')
  })

  it('links back to the parent account, the only route a person has', async () => {
    await render(person(), { parentName: 'Quillfort Security' })
    const link = button('Quillfort Security')
    expect(link).toBeTruthy()
    await act(async () => {
      link!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onOpenParent).toHaveBeenCalledWith('c1')
  })

  it('renders the company as plain text when there is no parent to open', async () => {
    await render(person({ parent_entry_id: null }))
    expect(text()).toContain('Quillfort Security')
    expect(button('Quillfort Security')).toBeUndefined()
  })

  it('renders the research blob through the shared Details vocabulary', async () => {
    await render(
      person({
        research: {
          fields: {
            why_relevant: {
              value: 'Owns the RevOps tooling budget and has been hiring SDRs.',
              source_url: 'https://quillfort.ai/team',
              confidence: 'high',
            },
          },
        },
      }),
    )
    expect(text()).toContain('Owns the RevOps tooling budget')
  })

  it('saves an anchored person on the first click — no confirm in the way', async () => {
    await render(person())
    const save = button('Save to list')
    expect(save).toBeTruthy()
    expect(save!.disabled).toBe(false)
    await act(async () => {
      save!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    // No `confirmUnverified` — the identity gate had nothing to ask about.
    expect(onSave.mock.calls[0][0]).toBeUndefined()
  })

  it('dismisses', async () => {
    await render(person())
    await act(async () => {
      button('Dismiss')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('never renders an empty heading', async () => {
    await render(person({ candidate: {} }))
    const heading = container.querySelector('h1')
    expect(heading?.textContent?.trim()).toBe('linkedin.com/in/dana-reyes')
  })
})

/**
 * THE IDENTITY GATE, as a question rather than a refusal — asked at PUBLISH
 * time (migration 259).
 *
 * `needs_review` means nothing on the company's own domain confirmed this
 * person works there — the Devin Marsh namesake class. Save keeps them on
 * the list like anyone else; the list PUBLISH holds them back, so the ONLY
 * route into the CRM is a per-row look, and the panel is where the evidence
 * for that look already is. Two clicks: the first states what could not be
 * confirmed, the second carries `confirmUnverified` for this one id.
 */
describe('EntryPanel — person — the needs_review confirm', () => {
  const held = { identity_state: 'needs_review' as const, stage: 'saved' as const, published_at: null }

  it('saves an unverified person like anyone else — Save is the list, not the CRM', async () => {
    await render(person({ identity_state: 'needs_review' }))
    await act(async () => {
      button('Save to list')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toBeUndefined()
    expect(text()).not.toContain('Publish anyway')
  })

  it('offers Publish anyway on a saved, unpublished, unverified person — and asks first, naming the company', async () => {
    await render(person(held), { parentName: 'Quillfort Security' })
    await act(async () => {
      button('Publish anyway')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // NOTHING was written on the first click.
    expect(onSave).not.toHaveBeenCalled()
    expect(text()).toContain(
      'This person could not be verified at Quillfort Security. Publish anyway?',
    )
  })

  it('passes confirmUnverified only on the second click', async () => {
    await render(person(held))
    await act(async () => {
      button('Publish anyway')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      button('Publish anyway')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith({ confirmUnverified: true })
  })

  it('cancels back without writing anything', async () => {
    await render(person(held))
    await act(async () => {
      button('Publish anyway')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      button('Cancel')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSave).not.toHaveBeenCalled()
    expect(text()).not.toContain('Publish anyway?')
    expect(button('Publish anyway')).toBeTruthy()
  })

  it('falls back to the anchor domain when no company name is known', async () => {
    await render(
      person({
        ...held,
        candidate: { name: 'Dana Reyes', domain: 'quillfort.ai' },
      }),
    )
    await act(async () => {
      button('Publish anyway')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(text()).toContain('could not be verified at quillfort.ai')
  })

  it('says the person is on the list once saved, and in the CRM once published', async () => {
    await render(person({ stage: 'saved', published_at: null }))
    const onList = button('On the list')
    expect(onList).toBeTruthy()
    expect(onList!.disabled).toBe(true)

    await render(person({ stage: 'saved', published_at: '2026-09-06T00:00:00Z', contact_id: 'contact-1' }))
    const inCrm = button('In your CRM')
    expect(inCrm).toBeTruthy()
    expect(inCrm!.disabled).toBe(true)
    expect(button('Publish anyway')).toBeUndefined()
  })
})

/**
 * ADD TO SEQUENCE is Save-then-enroll (§8): the dialog takes contact ids and
 * this person has none yet. The panel's job is only to state honestly whether
 * the flow can work — a person with no email cannot be enrolled at all, and
 * saying so on the control beats a toast after the click.
 */
describe('EntryPanel — person — add to sequence', () => {
  it('disables the control with the reason when there is no email', async () => {
    await render(person())
    const add = button('Add to sequence')
    expect(add).toBeTruthy()
    expect(add!.disabled).toBe(true)
    expect(add!.getAttribute('title')).toContain('No email address')
    expect(onAddToSequence).not.toHaveBeenCalled()
  })

  it('enables it for a person who has one', async () => {
    await render(
      person({ candidate: { ...(person().candidate as object), email: 'dana@quillfort.ai' } }),
    )
    const add = button('Add to sequence')
    expect(add!.disabled).toBe(false)
    await act(async () => {
      add!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onAddToSequence).toHaveBeenCalledTimes(1)
  })

  it('withholds it entirely once they are already in a sequence', async () => {
    // Re-enrolling is a Sequences-page decision, not a triage one.
    await render(person({ stage: 'saved', contact_id: 'contact-1' }), {
      sequenced: { status: 'active', sequence_id: 'seq-1', sequence_name: 'Q4 outbound' },
    })
    expect(button('Add to sequence')).toBeUndefined()
  })
})

/** DERIVED at read time from `sequence_enrollment` — never a column (§8). */
describe('EntryPanel — person — the Sequenced chip', () => {
  it('renders nothing when the person is in no sequence', async () => {
    await render(person())
    expect(container.querySelector('[data-prospect-sequenced]')).toBeNull()
  })

  it('names the sequence on an active enrollment', async () => {
    await render(person({ stage: 'saved', contact_id: 'contact-1' }), {
      sequenced: { status: 'active', sequence_id: 'seq-1', sequence_name: 'Q4 outbound' },
    })
    const chip = container.querySelector('[data-prospect-sequenced="active"]')
    expect(chip?.textContent).toBe('Sequenced')
    expect(chip?.getAttribute('title')).toBe('Active in Q4 outbound')
  })

  it('says EXITED out loud rather than collapsing it into Sequenced', async () => {
    // On the row where a user decides whether to enroll someone again, "in a
    // sequence" and "finished a sequence" are different answers.
    await render(person({ stage: 'saved', contact_id: 'contact-1' }), {
      sequenced: { status: 'exited', sequence_id: 'seq-1', sequence_name: 'Q4 outbound' },
    })
    const chip = container.querySelector('[data-prospect-sequenced="exited"]')
    expect(chip?.textContent).toBe('Sequenced (done)')
    expect(chip?.getAttribute('title')).toBe('Finished Q4 outbound')
  })

  /**
   * WHAT THE SLIM PERSON ROW HANDED OVER.
   *
   * The row is 40px and now shows the email only as a coloured DOT (the address
   * is in its title) and dropped the LinkedIn icon link entirely — neither an
   * address nor a second icon fits beside a name, a title and a company. That
   * is only honest because this panel is where both are legible, which is what
   * these pin.
   *
   * They also pin the company, for the same reason the person row keeps its
   * company chip: a person with no employer on screen is unusable, and a
   * discovered person's `company_id` is NULL by construction, so the parent
   * entry's name is the only thing that can say it.
   */
  it('carries the LinkedIn link the row gave up', async () => {
    await render(person())
    const link = container.querySelector('[data-prospect-linkedin]') as HTMLAnchorElement | null
    expect(link, 'the LinkedIn link lives here now, not in the row').toBeTruthy()
    // Schemeless in the blob, absolute in the href — an anchor without a scheme
    // resolves against the app's own origin.
    expect(link!.getAttribute('href')).toBe('https://linkedin.com/in/dana-reyes')
    expect(link!.getAttribute('rel')).toContain('noopener')
  })

  it('spells out the email address, and says so plainly when there is none', async () => {
    await render(
      person({
        candidate: {
          ...(person().candidate as Record<string, unknown>),
          email: 'dana@quillfort.ai',
        },
      }),
    )
    const email = container.querySelector('[data-prospect-email]')
    expect(email?.textContent).toContain('dana@quillfort.ai')
    expect(container.querySelector('[data-prospect-no-email]')).toBeNull()

    // The common case: most discovered people have a LinkedIn URL and nothing
    // else, and that is what decides whether they can be sequenced later.
    await render(person())
    expect(container.querySelector('[data-prospect-email]')).toBeNull()
    expect(container.querySelector('[data-prospect-no-email]')?.textContent).toContain(
      'No email found',
    )
  })

  it('names the company, preferring the page\'s own parent name', async () => {
    await render(person(), { parentName: 'Quillfort Security Inc' })
    expect(container.textContent).toContain('Quillfort Security Inc')

    // Falls back to the denormalised name on the candidate when the page has
    // not loaded the parent entry.
    await render(person())
    expect(container.textContent).toContain('Quillfort Security')
  })
})
