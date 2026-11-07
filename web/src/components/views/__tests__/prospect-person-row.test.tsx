// @vitest-environment jsdom
/**
 * The prospect PERSON row (§10, "People tab: checkbox, name, title, company,
 * email state, source link, status chip").
 *
 * WHY IT IS A SEPARATE BODY from the company row, pinned here rather than
 * argued in a comment: a person has no domain, no fit tier (fit lives on the
 * account it hangs off) and two facts a company row has no slot for — whether
 * we could verify the employer, and whether we have an email. Rendering one
 * through the other's layout produces a company list with holes in it.
 *
 * THE FOUR THINGS THIS SUITE DEFENDS:
 *
 * 1. **The name is never empty.** name → title → candidate_key → a literal.
 *    A person entry's title is a better fallback than its key, because the key
 *    is a linkedin slug or an email: unique and unreadable as a heading.
 *
 * 2. **The company is always named.** `company_id` is NULL on a person by
 *    construction (248's CHECK) and the shared views select carries no join,
 *    so the name is DENORMALISED into `candidate.company_name` at insert. If
 *    that ever stops being written, this test fails rather than the People tab
 *    quietly becoming a list of strangers.
 *
 * 3. **`needs_review` reads as "verify", muted.** It is the Devin Marsh
 *    namesake failure at 20× scale and the row must surface it — but the
 *    person is probably right, we just could not prove it, so overstating it
 *    with a warning colour would train users to ignore the one signal that
 *    matters.
 *
 * 4. **Save is live, and gated on the identity check.** `createProspectContact`
 *    promotes an emailless person, so the ✓ writes a real `contact` row — with
 *    the exception of a `needs_review` person, who is asked first. A hover
 *    button that quietly waived that check would be the namesake failure with
 *    a nicer interface.
 *
 * 5. **Add-to-sequence is Save-then-enroll, disabled with the reason when
 *    there is no email**, and **the Sequenced chip is DERIVED** from a map the
 *    page publishes — never a column, so it cannot claim a membership a
 *    sequence edit elsewhere has already ended.
 *
 * THE ROW IS SLIM NOW. The email ADDRESS collapsed to a dot (state is what the
 * row has to say; the address rides on the dot's title and lives in the panel)
 * and the LinkedIn link left the row entirely — the panel beside the list owns
 * it. Both were cells that cost the name and title their width at 40px, and
 * neither is read while scanning.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import {
  EntityRow,
  getTitle,
  publishProspectSequenced,
  PROSPECT_ENTRY_ACTION_EVENT,
  type ProspectEntryActionDetail,
} from '@/components/views/list/entity-row'
import { DEFAULT_DISPLAY_PROPERTIES } from '@/lib/views/types'

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
  // The store is module-level, so a map left behind would leak a chip onto the
  // next test's rows — exactly the failure the page's own unmount clear
  // prevents in production.
  act(() => publishProspectSequenced({}))
})

function person(overrides: Record<string, unknown> = {}) {
  return {
    id: 'person-1',
    list_id: 'list-1',
    kind: 'person',
    parent_entry_id: 'entry-1',
    candidate_key: 'linkedin.com/in/dana-reyes',
    candidate: {
      name: 'Dana Reyes',
      title: 'VP of Revenue Operations',
      domain: 'quillfort.ai',
      company_name: 'Quillfort Security',
      linkedin_url: 'linkedin.com/in/dana-reyes',
      email: null,
      found_via: 'synthesized',
    },
    stage: 'discovered',
    identity_state: 'anchored',
    fit_tier: null,
    fit_signals: [],
    research: null,
    ...overrides,
  }
}

async function render(
  item: Record<string, unknown>,
  displayProperties: string[] = DEFAULT_DISPLAY_PROPERTIES.prospect_list_entry,
) {
  await act(async () => {
    root.render(
      <EntityRow
        item={item}
        entityType="prospect_list_entry"
        displayProperties={displayProperties}
        isSelected={false}
        onItemSelect={() => {}}
      />,
    )
  })
}

function text(): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function name(): string {
  return container.querySelector('[data-prospect-name]')?.textContent?.trim() ?? ''
}

describe('prospect person row — identity', () => {
  it('renders name, title and the parent company', async () => {
    await render(person())
    expect(name()).toBe('Dana Reyes')
    const rendered = text()
    expect(rendered).toContain('VP of Revenue Operations')
    expect(rendered).toContain('Quillfort Security')
  })

  it('falls back to the TITLE before the key when the name is missing', async () => {
    await render(
      person({ candidate: { title: 'Head of Sales', domain: 'acme.com', company_name: 'Acme' } }),
    )
    // Not the linkedin slug — a key is unique and unreadable.
    expect(name()).toBe('Head of Sales')
  })

  it('is NEVER empty, even with an empty candidate blob', async () => {
    await render(person({ candidate: {}, candidate_key: '' }))
    expect(name()).toBe('Unknown person')
    expect(name().length).toBeGreaterThan(0)
  })

  it('falls back to the anchor domain when company_name was not denormalised', async () => {
    // The domain IS a real answer: it is the site the search was restricted to.
    await render(
      person({
        candidate: { name: 'Dana Reyes', title: 'VP RevOps', domain: 'quillfort.ai' },
      }),
    )
    expect(text()).toContain('quillfort.ai')
  })

  it('getTitle agrees with the row for a person', async () => {
    expect(getTitle('prospect_list_entry', person())).toBe('Dana Reyes')
    expect(
      getTitle('prospect_list_entry', person({ candidate: { title: 'Head of Sales' } })),
    ).toBe('Head of Sales')
  })
})

describe('prospect person row — the two person-only facts', () => {
  it('says whether there is an email with a DOT, and puts the address on its title', async () => {
    // The state is what predicts whether the sequence control beside it will
    // work; the address is forty characters nobody reads at 40px, so it is a
    // hover answer on the one row being checked and a panel field otherwise.
    await render(person())
    const none = container.querySelector('[data-prospect-email="none"]')!
    expect(none).toBeTruthy()
    expect(none.getAttribute('title')).toContain('No email found')
    expect(none.getAttribute('aria-label')).toBe('No email found')
    expect(none.className).toContain('bg-muted-foreground/40')
    // The address is nowhere in the row's text — it is a dot, not a chip.
    expect(text()).not.toContain('no email')

    await render(person({ candidate: { ...person().candidate, email: 'dana@quillfort.ai' } }))
    const present = container.querySelector('[data-prospect-email="present"]')!
    expect(present.className).toContain('bg-emerald-500')
    expect(present.getAttribute('title')).toBe('dana@quillfort.ai')
    expect(present.getAttribute('aria-label')).toBe('Email: dana@quillfort.ai')
    expect(text()).not.toContain('dana@quillfort.ai')
  })

  it('flags needs_review as "verify", muted rather than alarming', async () => {
    await render(person({ identity_state: 'needs_review' }))
    const chip = Array.from(container.querySelectorAll('span')).find(
      (s) => s.textContent?.trim() === 'verify',
    )
    expect(chip).toBeTruthy()
    // Muted, not a warning colour — the person is probably right, we just
    // could not prove it, and these rows are already held out of bulk save.
    expect(chip!.className).toContain('text-muted-foreground')
    expect(chip!.className).not.toMatch(/rose|amber|red/)
    expect(chip!.getAttribute('title')).toContain('could not confirm')
  })

  it('does not flag an anchored person', async () => {
    await render(person())
    expect(text()).not.toContain('verify')
  })

  it('does NOT carry the LinkedIn link — the entry panel owns it', async () => {
    // One more 20px icon per row, on a row whose name and title were already
    // fighting for width. The panel beside the list has room for a real,
    // labelled link; the row does not.
    await render(person())
    expect(container.querySelector('a[href*="linkedin"]')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
  })
})

/** Every action the row can state, captured through the PUBLIC event. */
function recordActions(): { seen: ProspectEntryActionDetail[]; stop: () => void } {
  const seen: ProspectEntryActionDetail[] = []
  const onAction = (e: Event) => seen.push((e as CustomEvent<ProspectEntryActionDetail>).detail)
  window.addEventListener(PROSPECT_ENTRY_ACTION_EVENT, onAction)
  return { seen, stop: () => window.removeEventListener(PROSPECT_ENTRY_ACTION_EVENT, onAction) }
}

function byLabel(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === label,
  )
}

function byText(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  )
}

describe('prospect person row — actions', () => {
  it('saves an anchored person on the click — no confirm, no flag', async () => {
    const rec = recordActions()
    await render(person())
    const save = byLabel('Save to list')
    expect(save).toBeTruthy()
    await act(async () => {
      save!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    rec.stop()
    expect(rec.seen).toEqual([{ action: 'save', entryIds: ['person-1'] }])
  })

  it('saves a needs_review person like anyone else — Save is the list, and the gate is asked at publish time', async () => {
    // Save keeps them on the list (migration 259); nothing reaches the CRM
    // until the list is published, which is where the namesake gate lives.
    const rec = recordActions()
    await render(person({ identity_state: 'needs_review' }))
    await act(async () => {
      byLabel('Save to list')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    rec.stop()
    expect(rec.seen).toEqual([{ action: 'save', entryIds: ['person-1'] }])
    expect(text()).not.toContain('Publish anyway')
  })

  it('offers Publish anyway on a SAVED, unpublished, unverified person — sending confirmUnverified for that ONE id', async () => {
    // The list publish held this person back. The escape hatch is per row,
    // says what could not be proven, and the page publishes just them.
    const rec = recordActions()
    await render(person({ identity_state: 'needs_review', stage: 'saved', published_at: null }))
    expect(text()).toContain('Could not verify at Quillfort Security.')
    await act(async () => {
      byText('Publish anyway')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    rec.stop()
    expect(rec.seen).toEqual([
      { action: 'save', entryIds: ['person-1'], confirmUnverified: true },
    ])
  })

  it('withholds Publish anyway once the person is published — and while they are not saved', async () => {
    await render(
      person({
        identity_state: 'needs_review',
        stage: 'saved',
        published_at: '2026-09-06T00:00:00Z',
        contact_id: 'contact-1',
      }),
    )
    expect(text()).not.toContain('Publish anyway')
    await render(person({ identity_state: 'needs_review' }))
    expect(text()).not.toContain('Publish anyway')
  })

  it('does not offer Save on an already-saved person', async () => {
    await render(person({ stage: 'saved', contact_id: 'contact-1' }))
    expect(byLabel('Save to list')).toBeUndefined()
  })
})

describe('prospect person row — add to sequence', () => {
  it('states the intent for a person who has an email', async () => {
    const rec = recordActions()
    await render(person({ candidate: { ...person().candidate, email: 'dana@quillfort.ai' } }))
    const add = byLabel('Add to sequence')
    expect(add).toBeTruthy()
    await act(async () => {
      add!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    rec.stop()
    expect(rec.seen).toEqual([{ action: 'sequence', entryIds: ['person-1'] }])
  })

  it('is inert with the reason on it when there is no email', async () => {
    await render(person())
    // Not a button: sequences send email, and a pressable control that could
    // only ever report `no_email` afterwards states the truth too late.
    expect(byLabel('Add to sequence')).toBeUndefined()
    const disabled = container.querySelector('[aria-label="Cannot add to sequence: no email address"]')
    expect(disabled).toBeTruthy()
    expect(disabled!.getAttribute('title')).toContain('No email address')
  })

  it('withholds it once the person is already in a sequence', async () => {
    await act(async () => {
      publishProspectSequenced({
        'contact-1': { status: 'active', sequence_id: 'seq-1', sequence_name: 'Q4 outbound' },
      })
    })
    await render(
      person({
        stage: 'saved',
        contact_id: 'contact-1',
        candidate: { ...person().candidate, email: 'dana@quillfort.ai' },
      }),
    )
    expect(byLabel('Add to sequence')).toBeUndefined()
  })
})

describe('prospect person row — the Sequenced chip', () => {
  it('renders nothing for a person in no sequence', async () => {
    await render(person({ stage: 'saved', contact_id: 'contact-1' }))
    expect(container.querySelector('[data-prospect-sequenced]')).toBeNull()
  })

  it('renders from the published map, keyed on contact_id', async () => {
    await act(async () => {
      publishProspectSequenced({
        'contact-1': { status: 'active', sequence_id: 'seq-1', sequence_name: 'Q4 outbound' },
      })
    })
    await render(person({ stage: 'saved', contact_id: 'contact-1' }))
    const chip = container.querySelector('[data-prospect-sequenced="active"]')
    expect(chip?.textContent).toBe('Sequenced')
    expect(chip?.getAttribute('title')).toBe('Active in Q4 outbound')
  })

  it('says EXITED out loud', async () => {
    await act(async () => {
      publishProspectSequenced({
        'contact-1': { status: 'exited', sequence_id: 'seq-1', sequence_name: 'Q4 outbound' },
      })
    })
    await render(person({ stage: 'saved', contact_id: 'contact-1' }))
    expect(
      container.querySelector('[data-prospect-sequenced="exited"]')?.textContent,
    ).toBe('Sequenced (done)')
  })

  it('cannot appear on an UNSAVED candidate — there is no contact to enroll', async () => {
    await act(async () => {
      publishProspectSequenced({
        'contact-1': { status: 'active', sequence_id: 'seq-1', sequence_name: 'Q4 outbound' },
      })
    })
    await render(person({ contact_id: null }))
    expect(container.querySelector('[data-prospect-sequenced]')).toBeNull()
  })

  it('repaints a mounted row when the map is republished', async () => {
    await render(person({ stage: 'saved', contact_id: 'contact-1' }))
    expect(container.querySelector('[data-prospect-sequenced]')).toBeNull()
    await act(async () => {
      publishProspectSequenced({
        'contact-1': { status: 'active', sequence_id: 'seq-1', sequence_name: 'Q4 outbound' },
      })
    })
    expect(container.querySelector('[data-prospect-sequenced="active"]')).toBeTruthy()
  })
})

describe('prospect person row — dismissal', () => {

  it('dismisses through the same event the company row uses', async () => {
    const seen: ProspectEntryActionDetail[] = []
    const onAction = (e: Event) =>
      seen.push((e as CustomEvent<ProspectEntryActionDetail>).detail)
    window.addEventListener(PROSPECT_ENTRY_ACTION_EVENT, onAction)

    await render(person())
    const dismiss = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Dismiss',
    )
    expect(dismiss).toBeTruthy()
    await act(async () => {
      dismiss!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    window.removeEventListener(PROSPECT_ENTRY_ACTION_EVENT, onAction)
    expect(seen).toEqual([{ action: 'dismiss', entryIds: ['person-1'] }])
  })

  it('does not offer Dismiss on an already-dismissed person', async () => {
    await render(person({ stage: 'dismissed' }))
    const dismiss = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Dismiss',
    )
    expect(dismiss).toBeUndefined()
  })

  it('renders no fit chip — fit lives on the account, not the person', async () => {
    await render(person())
    expect(container.querySelector('[data-fit-tier]')).toBeNull()
  })
})
