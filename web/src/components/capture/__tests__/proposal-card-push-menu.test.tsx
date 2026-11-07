// @vitest-environment jsdom
/**
 * The push control on a capture's extracted action items.
 *
 * The whole point of putting it on the ROW (rather than only in the action
 * panel) is that a meeting's action items are pushed while you're reading the
 * notes, before you've opened anything — including items that are still
 * SUGGESTED. So the row's push has to be a two-step gesture, and the ordering is
 * the contract:
 *
 *   suggested → confirm (the apply route, which drives apply-engine's
 *   createAction) → push the action THAT call returned. Never a lookup after the
 *   fact, and never a push before the confirm has actually landed.
 *
 * An already-confirmed row skips step one entirely — re-confirming an applied
 * proposal is a 400 ("Change is not pending"), so a retry after a failed push
 * must not attempt it.
 *
 * TWO THINGS MOVED under this suite, and neither changed the contract above.
 * The control is now the FAR-LEFT PLATFORM MARK rather than a trailing button
 * (one affordance per row, and the left one also says which trackers the action
 * is already in), and picking a destination opens the compose panel whose
 * Create is what pushes. `pushToAsana()` below still performs the whole gesture,
 * so every ordering assertion reads exactly as it did.
 *
 * Radix's DropdownMenu, Dialog and Select can't be driven in jsdom; all three
 * are replaced with plain elements preserving the contracts the components rely
 * on (controlled open / onSelect / disabled / onValueChange).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1' }))
vi.mock('@/lib/cached-fetch', () => ({
  cachedJson: async (url: string) => {
    const res = await fetch(url)
    return res.ok ? res.json() : null
  },
}))

vi.mock('@/components/ui/dropdown-menu', async () => {
  const { createContext, useContext, createElement: e, cloneElement, isValidElement } =
    await import('react')
  const MenuCtx = createContext<{ open: boolean; setOpen: (v: boolean) => void }>({
    open: false,
    setOpen: () => {},
  })
  return {
    DropdownMenu: ({
      open,
      onOpenChange,
      children,
    }: {
      open?: boolean
      onOpenChange?: (v: boolean) => void
      children?: React.ReactNode
    }) =>
      e(
        MenuCtx.Provider,
        { value: { open: !!open, setOpen: (v: boolean) => onOpenChange?.(v) } },
        children,
      ),
    // `asChild` semantics, and they matter here: the real trigger MERGES its
    // open handler onto the child element, and the child (ActionPlatformIcon)
    // stops propagation so the capture row underneath doesn't act on the same
    // click. A wrapper that put the handler on a parent span would never hear
    // it — which is a fact about the substitute, not about the component.
    DropdownMenuTrigger: ({ children }: { children?: React.ReactNode }) => {
      const ctx = useContext(MenuCtx)
      if (isValidElement(children)) {
        const child = children as React.ReactElement<{ onClick?: (e: unknown) => void }>
        return cloneElement(child, {
          onClick: (event: unknown) => {
            child.props.onClick?.(event)
            ctx.setOpen(!ctx.open)
          },
        })
      }
      return e('span', { 'data-menu-trigger': '', onClick: () => ctx.setOpen(!ctx.open) }, children)
    },
    DropdownMenuContent: ({ children }: { children?: React.ReactNode }) => {
      const ctx = useContext(MenuCtx)
      return ctx.open ? e('div', { 'data-menu-content': '' }, children) : null
    },
    DropdownMenuItem: ({
      children,
      disabled,
      onSelect,
    }: {
      children?: React.ReactNode
      disabled?: boolean
      onSelect?: (event: { preventDefault: () => void }) => void
    }) =>
      e(
        'button',
        {
          type: 'button',
          'data-menu-item': '',
          onClick: () => {
            if (!disabled) onSelect?.({ preventDefault: () => {} })
          },
        },
        children,
      ),
    DropdownMenuSeparator: () => e('hr'),
    DropdownMenuGroup: ({ children }: { children?: React.ReactNode }) => e('div', {}, children),
  }
})

vi.mock('@/components/ui/select', async () => {
  const { createElement: e } = await import('react')
  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value?: string
      onValueChange?: (v: string) => void
      children?: React.ReactNode
    }) =>
      e(
        'select',
        {
          value: value ?? '',
          onChange: (ev: { target: { value: string } }) => onValueChange?.(ev.target.value),
        },
        children,
      ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children?: React.ReactNode }) => e('optgroup', {}, children),
    SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) =>
      e('option', { value }, children),
  }
})

import { ProposalCard } from '../proposal-card'
import type { ProposedChange } from '@/lib/proposed-changes/types'

const ASANA = { provider: 'asana', name: 'Asana', configured: true, destinationLabel: 'Engineering' }
const LINK = {
  id: 'link-1',
  provider: 'asana',
  external_id: 'gid-1',
  external_url: 'https://app.asana.com/0/1/2',
  external_title: 'Ship the thing',
  completed: false,
}

let calls: Array<{ url: string; method: string }> = []

function installFetch(opts: { pushOk?: boolean } = {}) {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      if (url.startsWith('/api/account/task-destinations')) {
        return { ok: true, status: 200, json: async () => ({ destinations: [ASANA] }) }
      }
      // The compose panel's own reads. Minimal on purpose — which fields the
      // panel draws and what it sends is pinned by its own suite; all this
      // suite needs is a config complete enough for Create to be available.
      if (url.includes('/workspace/asana-settings')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            connected: true,
            config: { asana_workspace_gid: 'ws-gid', project_gid: 'proj-1' },
          }),
        }
      }
      if (url.includes('/asana/projects')) {
        return { ok: true, status: 200, json: async () => ({ projects: [{ gid: 'proj-1', name: 'Engineering' }] }) }
      }
      if (url.includes('/asana/sections')) {
        return { ok: true, status: 200, json: async () => ({ sections: [] }) }
      }
      if (url.includes('/asana/users')) {
        return { ok: true, status: 200, json: async () => ({ users: [] }) }
      }
      if (method === 'POST') {
        return opts.pushOk === false
          ? { ok: false, status: 500, json: async () => ({ error: 'Asana is down' }) }
          : { ok: true, status: 201, json: async () => ({ task: LINK }) }
      }
      return { ok: true, status: 200, json: async () => ({ tasks: [] }) }
    }),
  )
}

function makeChange(overrides: Partial<ProposedChange> = {}): ProposedChange {
  return {
    id: 'pc-1',
    workspace_id: 'ws-1',
    capture_id: 'cap-1',
    change_type: 'create',
    entity_type: 'action',
    entity_id: null,
    display_text: 'Send the pricing deck to Ada',
    title: 'Send the pricing deck',
    description: null,
    priority: null,
    due_date: null,
    status_from: null,
    status_to: null,
    assignee_name: null,
    assignee_member_id: null,
    assignee_contact_id: null,
    team_id: null,
    project_id: null,
    labels: null,
    email_to_name: null,
    email_to_address: null,
    email_subject: null,
    email_context: null,
    extra: null,
    anchor_text: null,
    sort_order: 0,
    confidence: 0.9,
    trigger_quote: null,
    reasoning: null,
    stakes: null,
    open_questions: null,
    status: 'pending',
    applied_at: null,
    applied_by: null,
    result_entity_id: null,
    error_message: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

let container: HTMLDivElement
let root: Root

/**
 * The push control — now the far-left platform mark rather than a trailing
 * outlined button. Found by `data-platform-icon` (which ActionPlatformIcon sets
 * to the providers it drew, or 'dial8' when there are none) rather than by
 * position, since position is exactly what changed.
 */
function pushTrigger(): HTMLButtonElement | undefined {
  return (container.querySelector('[data-platform-icon]') as HTMLButtonElement | null) ?? undefined
}

/**
 * The compose form's Create button, once a destination has been picked.
 *
 * RE-TARGETED (the inline-compose rework): scoped to the compose STRIP the card
 * now renders on its own row, rather than to a `[data-dialog]` that no longer
 * exists. Same button, same meaning — the proposal card hosts the form itself
 * (it has a property strip of its own), so there is no test-supplied host here.
 */
function createButton(): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('[data-compose-surface] button')).find((b) =>
    b.textContent?.trim().startsWith('Create in'),
  ) as HTMLButtonElement | undefined
}

/** The row's primary Accept button (deriveButtonLabel for create:action). */
function acceptButton(): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Create task',
  ) as HTMLButtonElement | undefined
}

function menuItem(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('[data-menu-content] [data-menu-item]')).find(
    (b) => b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined
}

async function renderCard(
  change: ProposedChange,
  onApply: (id: string) => Promise<string | null | void>,
) {
  await act(async () => {
    root.render(
      h(ProposalCard, {
        change,
        onApply,
        onDismiss: vi.fn(async () => {}),
        onEdit: vi.fn(async () => {}),
      }),
    )
  })
}

/** The whole gesture: open the menu, choose Asana, Create in the panel. */
async function pushToAsana() {
  await act(async () => {
    pushTrigger()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    menuItem('Push to Asana')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    createButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  installFetch()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ProposalCard — push to tracker', () => {
  it('a SUGGESTED row confirms first, then pushes the created action', async () => {
    const onApply = vi.fn(async () => 'new-act-9')
    await renderCard(makeChange(), onApply)
    await pushToAsana()

    expect(onApply).toHaveBeenCalledWith('pc-1')
    // Ordering matters: the confirm has to have landed before the push, and the
    // push targets exactly the id it returned.
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      { url: '/api/account/actions/new-act-9/asana', method: 'POST' },
    ])
    expect(toastMock.success).toHaveBeenCalledWith(
      'Action created and pushed to Asana',
      expect.objectContaining({ action: expect.objectContaining({ label: 'View task' }) }),
    )
  })

  it('CONFIRM OK + PUSH FAILED says the action was created', async () => {
    installFetch({ pushOk: false })
    const onApply = vi.fn(async () => 'new-act-9')
    await renderCard(makeChange(), onApply)
    await pushToAsana()

    expect(onApply).toHaveBeenCalledTimes(1)
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledWith(
      'Action created, but the push to Asana failed',
      expect.objectContaining({ description: 'Asana is down' }),
    )
  })

  it('a retry after a failed push does NOT re-confirm (the row is applied now)', async () => {
    // Re-applying an applied proposal is a 400 server-side, so the retry has to
    // go straight to the push. This is the state the row lands in after the
    // confirm-ok/push-failed path above.
    const onApply = vi.fn(async () => 'new-act-9')
    await renderCard(
      makeChange({ status: 'applied', result_entity_id: 'new-act-9' }),
      onApply,
    )
    await pushToAsana()

    expect(onApply).not.toHaveBeenCalled()
    expect(calls).toContainEqual({ url: '/api/account/actions/new-act-9/asana', method: 'POST' })
  })

  it('a CONFIRMED row pushes straight through with no confirm call', async () => {
    const onApply = vi.fn(async () => 'unused')
    await renderCard(
      makeChange({ status: 'applied', result_entity_id: 'act-7', auto_accepted: true }),
      onApply,
    )
    await pushToAsana()

    expect(onApply).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      { url: '/api/account/actions/act-7/asana', method: 'POST' },
    ])
    expect(toastMock.success).toHaveBeenCalledWith('Pushed to Asana', expect.anything())
  })

  it('does not push when the confirm fails', async () => {
    const onApply = vi.fn(async () => null)
    await renderCard(makeChange(), onApply)
    await pushToAsana()

    expect(onApply).toHaveBeenCalledTimes(1)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('DISMISSED rows have no push control (the card renders nothing)', async () => {
    await renderCard(makeChange({ status: 'dismissed' }), vi.fn(async () => null))
    expect(pushTrigger()).toBeUndefined()
    expect(container.textContent).toBe('')
  })

  it('read-only cards have no push control', async () => {
    await act(async () => {
      root.render(
        h(ProposalCard, {
          change: makeChange(),
          onApply: vi.fn(async () => {}),
          onDismiss: vi.fn(async () => {}),
          onEdit: vi.fn(async () => {}),
          readOnly: true,
        }),
      )
    })
    expect(pushTrigger()).toBeUndefined()
  })

  it('is not offered on a row whose confirm would dead-end (targetless update)', async () => {
    // A target-less update:action can't be confirmed in one click — it needs the
    // action picker first, so offering a push here would promise a gesture that
    // can't complete.
    await renderCard(
      makeChange({ change_type: 'update', entity_id: null }),
      vi.fn(async () => null),
    )
    expect(pushTrigger()).toBeUndefined()
  })

  it('is not offered on a non-action proposal', async () => {
    await renderCard(
      makeChange({ entity_type: 'decision' }),
      vi.fn(async () => null),
    )
    expect(pushTrigger()).toBeUndefined()
  })
})

/**
 * Accept and the push menu are two doors onto the SAME confirm. While one is
 * open, the other has to be shut — a suggested row's result_entity_id stays null
 * until the POST returns, so nothing downstream can tell the second confirm that
 * the first one is already creating the action.
 */
describe('ProposalCard — push menu vs. an in-flight accept', () => {
  /** An accept that never settles, so the row stays mid-apply for the assertions. */
  function deferredApply() {
    let release: (id: string) => void = () => {}
    const onApply = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
    )
    return { onApply, release: (id = 'new-act-9') => release(id) }
  }

  it('DISABLES the push menu while the accept is in flight', async () => {
    const { onApply, release } = deferredApply()
    await renderCard(makeChange(), onApply)
    expect(pushTrigger()!.disabled).toBe(false)

    await act(async () => {
      acceptButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onApply).toHaveBeenCalledTimes(1)
    expect(pushTrigger()!.disabled).toBe(true)

    await act(async () => {
      release()
    })
  })

  it('a destination picked from an ALREADY-OPEN menu does not confirm a second time', async () => {
    // Disabling the trigger cannot help here: the menu was open before Accept
    // was clicked. This is the belt to that brace — one apply, one action.
    const { onApply, release } = deferredApply()
    await renderCard(makeChange(), onApply)

    await act(async () => {
      pushTrigger()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      acceptButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      menuItem('Push to Asana')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onApply).toHaveBeenCalledTimes(1)
    // No push either — the id it would target doesn't exist yet, and the
    // in-flight accept owns the messaging (so no toast on top of it).
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    expect(toastMock.error).not.toHaveBeenCalled()

    await act(async () => {
      release()
    })
  })

  it('the Accept button itself cannot double-fire', async () => {
    const { onApply, release } = deferredApply()
    await renderCard(makeChange(), onApply)

    await act(async () => {
      acceptButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      acceptButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onApply).toHaveBeenCalledTimes(1)

    await act(async () => {
      release()
    })
  })
})

/**
 * Where the control LIVES, and when it shows.
 *
 * The far-left slot used to hold a decorative Circle — a "still pending" marker
 * that correctly vanished on accept, because the green Accepted button on the
 * right already said the same thing. A platform mark is not that: it says which
 * trackers the action is already in and offers to send it to another, and an
 * ACCEPTED row is exactly when that becomes most useful, since there is finally
 * a real action to push. So the hide-on-accept rule is INVERTED for actions and
 * kept, unchanged, for everything else.
 */
describe('ProposalCard — the far-left slot', () => {
  /** The decorative pending Circle, which is what a non-action row still gets. */
  function pendingCircle(): Element | null {
    return container.querySelector('svg.lucide-circle')
  }

  it('a PENDING action row shows the platform mark (the Circle is gone)', async () => {
    await renderCard(makeChange(), vi.fn(async () => 'act-1'))
    expect(pushTrigger()).toBeTruthy()
    expect(pushTrigger()!.getAttribute('data-platform-icon')).toBe('dial8')
    expect(pendingCircle()).toBeNull()
  })

  it('AN APPLIED action row KEEPS it — the inversion', async () => {
    // The old Circle was dropped on accept. This must not be: an accepted row is
    // the one with a real action to push.
    await renderCard(
      makeChange({ status: 'applied', result_entity_id: 'act-7' }),
      vi.fn(async () => 'unused'),
    )
    expect(pushTrigger()).toBeTruthy()
  })

  it('a NON-action pending row still shows the plain Circle', async () => {
    await renderCard(makeChange({ entity_type: 'decision' }), vi.fn(async () => null))
    expect(pushTrigger()).toBeUndefined()
    expect(pendingCircle()).toBeTruthy()
  })

  it('a non-action APPLIED row still drops it entirely, exactly as before', async () => {
    await renderCard(
      makeChange({ entity_type: 'decision', status: 'applied', result_entity_id: 'dec-1' }),
      vi.fn(async () => null),
    )
    expect(pushTrigger()).toBeUndefined()
    expect(pendingCircle()).toBeNull()
  })

  it('a row that cannot be pushed falls back to the Circle rather than an empty slot', async () => {
    // A targetless update can't be confirmed in one click, so there is nothing
    // to push — but the left slot still has to say "pending".
    await renderCard(
      makeChange({ change_type: 'update', entity_id: null }),
      vi.fn(async () => null),
    )
    expect(pushTrigger()).toBeUndefined()
    expect(pendingCircle()).toBeTruthy()
  })

  it('THE TRAILING PUSH BUTTON IS GONE — one affordance per row', async () => {
    // It moved to the far-left slot. Two controls doing the same job in one row
    // is the collision this replacement exists to avoid.
    await renderCard(
      makeChange({ status: 'applied', result_entity_id: 'act-7' }),
      vi.fn(async () => 'unused'),
    )
    const marks = container.querySelectorAll('[data-platform-icon]')
    expect(marks).toHaveLength(1)
  })

  it('keeps the other trailing controls untouched', async () => {
    // Dismiss and the properties toggle are unrelated to the push and must not
    // have been disturbed by pulling the menu out from between them.
    await renderCard(makeChange(), vi.fn(async () => null))
    const titles = Array.from(container.querySelectorAll('button'))
      .map((b) => b.getAttribute('title'))
      .filter(Boolean)
    expect(titles).toContain('Dismiss')
    expect(titles).toContain('Edit properties')
  })
})

/**
 * THE COMPOSE STRIP OWNS A ROW OF ITS OWN.
 *
 * The reported bug: opening compose on a capture proposal drew a form with only
 * its Title field visible, the rest of the fields gone, and the proposal's own
 * text sitting to the right of it.
 *
 * The mechanism is a width one, and it is worth stating precisely because the
 * obvious reading ("`display:contents` collapses the scroller") is wrong — the
 * scroller does not collapse. While composing, the card wrapped the menu in
 * `display:contents`, which flattens the strip onto the CARD'S OWN flex line,
 * where it shares the width with the proposal's title block. Measured at the
 * capture panel's real width (max-w-2xl minus px-8 = 608px of content) that
 * leaves the strip's `flex-1 min-w-0` scroller ~189px against ~848px of fields:
 * the 220px Title field alone overflows it, so every later field is scrolled out
 * of view. Freeing the line takes the scroller to ~421px and the visible fields
 * from one to three — the rest still scroll, which is the strip's own contract.
 *
 * So the invariant is structural rather than cosmetic, and that is what these
 * pin: while composing, NOTHING of the card's normal row content shares the
 * strip's flex parent. Asserting on computed widths would need a real layout
 * engine (jsdom has none); asserting on the DOM shape catches the same
 * regression at the point where it is actually decided.
 */
/**
 * RE-FRAMED (the card-anatomy pass). This section was written when compose
 * turned the card's main row into a COLUMN and the strip took that row's line —
 * the mark migrated down beside the strip and the proposal text collapsed to a
 * truncated caption above it.
 *
 * The strip now hangs BELOW the top row instead, portalled into the property
 * line, so the card keeps its normal anatomy while composing. Every assertion
 * here still holds and none was weakened: "the strip has the line to itself" is
 * now true because the line is its OWN, not because the card's content stood
 * down. The anatomy this frees up is pinned in the section after this one.
 */
describe('ProposalCard — the compose strip owns its line', () => {
  /** Open the menu and pick Asana, stopping short of Create. */
  async function beginCompose() {
    await act(async () => {
      pushTrigger()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      menuItem('Push to Asana')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  const scroller = () => container.querySelector('[data-compose-scroller]')
  const strip = () => container.querySelector('[data-compose-surface="strip"]')

  /**
   * The flex line the strip actually lands on.
   *
   * NOT `strip().parentElement` — that is the whole point of the bug. A
   * `display:contents` wrapper is invisible to layout, so the strip's real flex
   * parent is the nearest ancestor that is NOT `contents`. Walking past those is
   * what makes this assertion see the same box the browser does.
   */
  function stripFlexLine(): Element | null {
    let el = strip()?.parentElement ?? null
    while (el && el.className.split(/\s+/).includes('contents')) el = el.parentElement
    return el
  }

  /**
   * The CARD's own content sharing the strip's flex line — the thing that must
   * be empty. Three kinds of sibling are legitimately there and are not it:
   *
   *  - the strip itself, or an ancestor of it;
   *  - the platform mark, which is the head of the compose row by design;
   *  - the open dropdown PANEL. Radix portals this to the body in the real
   *    build, so it is never on any card line; the jsdom substitute at the top
   *    of this file renders it inline instead, and excluding it here keeps the
   *    assertion about layout rather than about the stand-in.
   */
  function cardContentBesideStrip(line: Element): Element[] {
    return Array.from(line.children).filter(
      (c) =>
        c !== strip() &&
        !c.contains(strip()!) &&
        !c.hasAttribute('data-menu-content') &&
        !c.querySelector('[data-menu-content]') &&
        !c.hasAttribute('data-platform-icon') &&
        !c.querySelector('[data-platform-icon]'),
    )
  }

  it('does not leave the proposal text on the strip’s flex line', async () => {
    await renderCard(makeChange(), vi.fn(async () => 'act-1'))
    await beginCompose()
    expect(scroller()).toBeTruthy()

    // The proposal's text is the thing that was stealing the width. It may still
    // be on the CARD (a strip of dropdowns with no subject is its own bug) — it
    // just must not be a sibling competing for the same line.
    const line = stripFlexLine()!
    const text = cardContentBesideStrip(line).some((c) =>
      c.textContent?.includes('Send the pricing deck'),
    )
    expect(text).toBe(false)
  })

  it('gives the strip the line to itself — no card content beside it', async () => {
    await renderCard(makeChange(), vi.fn(async () => 'act-1'))
    await beginCompose()

    // Every child of the strip's flex line is the strip, or an ancestor of it.
    // Anything else is a second claimant on the width.
    const line = stripFlexLine()!
    expect(cardContentBesideStrip(line)).toEqual([])
  })

  it('an APPLIED row composes on the same terms', async () => {
    // Applied rows are compose-capable too, and they carry EXTRA trailing
    // content (the Accepted/Undo pill) that must stand down just the same.
    await renderCard(
      makeChange({ status: 'applied', result_entity_id: 'act-7' }),
      vi.fn(async () => 'unused'),
    )
    await beginCompose()

    expect(scroller()).toBeTruthy()
    const line = stripFlexLine()!
    expect(cardContentBesideStrip(line)).toEqual([])
    expect(container.textContent).not.toContain('Accepted')
  })

  it('restores the card’s normal content when compose is cancelled', async () => {
    await renderCard(makeChange(), vi.fn(async () => 'act-1'))
    await beginCompose()
    expect(scroller()).toBeTruthy()

    const cancel = Array.from(
      container.querySelectorAll('[data-compose-actions] button'),
    ).find((b) => (b.getAttribute('aria-label') || b.textContent || '').match(/cancel/i)) as
      | HTMLButtonElement
      | undefined
    expect(cancel).toBeTruthy()
    await act(async () => {
      cancel!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(scroller()).toBeNull()
    expect(container.textContent).toContain('Send the pricing deck to Ada')
    // The trailing cluster is back too — cancel is a state change, not a
    // navigation, so the row returns exactly as it was.
    const titles = Array.from(container.querySelectorAll('button'))
      .map((b) => b.getAttribute('title'))
      .filter(Boolean)
    expect(titles).toContain('Dismiss')
  })

  it('SURVIVES the toggle: the menu is not remounted, so compose state lives', async () => {
    // The menu OWNS `composing` in its own useState. Any fix that swaps the row
    // between two branches which each mount their own PushToTrackerMenu would
    // unmount it on the very click that enters compose — the form would flash
    // and vanish. Proven here by the form still standing after entering compose,
    // and by the push completing from it (a remounted menu would have lost the
    // destination and had nothing to Create).
    const onApply = vi.fn(async () => 'new-act-9')
    await renderCard(makeChange(), onApply)
    await beginCompose()

    expect(scroller()).toBeTruthy()
    expect(createButton()).toBeTruthy()

    await act(async () => {
      createButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      { url: '/api/account/actions/new-act-9/asana', method: 'POST' },
    ])
  })
})

/**
 * NEW — THE CARD KEEPS ITS ANATOMY WHILE COMPOSING.
 *
 * Liam's report, against the accepted card's own layout: composing should look
 * like the card it is, with only the property row swapped. What it did instead
 * was dismantle itself — the platform mark left its top-left slot and moved
 * down onto the strip's line, and the full wrapping title became a truncated
 * one-line `text-xs` caption. A composing card stopped reading as a card.
 *
 * These pins are the shape of the fix, and each names a specific regression the
 * previous layout had.
 */
describe('ProposalCard — compose keeps the card’s normal anatomy', () => {
  async function beginCompose() {
    await act(async () => {
      pushTrigger()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      menuItem('Push to Asana')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  const strip = () => container.querySelector('[data-compose-surface="strip"]')
  const mark = () => container.querySelector('[data-platform-icon]')
  /** The card's own top row — the line carrying the mark and the title. */
  const topRow = () => mark()!.closest('[data-proposal-row]') as HTMLElement
  const titleEl = () => container.querySelector('[data-proposal-title]') as HTMLElement

  it('THE MARK STAYS in its top-left slot, on the title’s line', async () => {
    await renderCard(makeChange(), vi.fn(async () => 'act-1'))
    await beginCompose()
    expect(strip()).toBeTruthy()

    // The row is still a ROW (it used to become `flex-col` while composing,
    // which is what let the mark slide underneath the text). The row lays out
    // with floats now, so the guarantee is stated structurally: the mark floats
    // left on the title's line rather than stacking above it.
    const row = topRow()
    expect(row.className).not.toContain('flex-col')
    expect(mark()!.closest('.float-left')).toBeTruthy()

    // The mark and the title share that row, and the strip is NOT on it.
    expect(row.textContent).toContain('Send the pricing deck to Ada')
    expect(row.contains(strip())).toBe(false)
  })

  it('THE TITLE STAYS FULL AND WRAPPING — not a truncated caption', async () => {
    await renderCard(makeChange(), vi.fn(async () => 'act-1'))

    // Its presentation before compose…
    const before = titleEl()
    expect(before).toBeTruthy()
    expect(before.className).toContain('text-sm')

    await beginCompose()

    // …is the presentation during compose. The old layout swapped these for
    // `order-first w-full truncate text-xs`, which is the caption Liam saw.
    const title = titleEl()
    expect(title).toBeTruthy()
    expect(title.textContent).toContain('Send the pricing deck to Ada')
    expect(title.className).toContain('text-sm')
    expect(title.className).not.toContain('truncate')
    expect(title.className).not.toContain('text-xs')
    expect(title.className).not.toContain('order-first')
  })

  it('the strip sits BELOW the top row, where the property pills would be', async () => {
    await renderCard(makeChange(), vi.fn(async () => 'act-1'))
    await beginCompose()

    const propertyRow = container.querySelector('[data-compose-property-row]')!
    expect(propertyRow).toBeTruthy()
    expect(propertyRow.contains(strip())).toBe(true)

    // Order on the page: the card's row first, the strip's line after it.
    expect(topRow().compareDocumentPosition(propertyRow) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
  })

  it('keeps the row’s read-only trailing controls, drops only the commit ones', async () => {
    await renderCard(makeChange(), vi.fn(async () => 'act-1'))
    await beginCompose()

    const titles = Array.from(container.querySelectorAll('button'))
      .map((b) => b.getAttribute('title'))
      .filter(Boolean)

    // Dismiss survives — it acts on the proposal, not on the push, and the card
    // keeping its shape is the whole point.
    expect(titles).toContain('Dismiss')

    // The properties toggle does NOT: the strip IS the property row while it is
    // up, so showing the native pills would put two property rows on one card.
    expect(titles).not.toContain('Edit properties')
    expect(titles).not.toContain('Hide properties')
  })

  it('an ACCEPTED row keeps its anatomy too, minus the Accept gesture', async () => {
    // The screenshot Liam compared against was the Accepted state, so this is
    // the case the anatomy has to match.
    await renderCard(
      makeChange({ status: 'applied', result_entity_id: 'act-7' }),
      vi.fn(async () => 'unused'),
    )
    await beginCompose()

    const row = topRow()
    expect(row.className).not.toContain('flex-col')
    expect(row.textContent).toContain('Send the pricing deck to Ada')
    // Accept/Undo stands down — it and Create are two commits on one row.
    expect(container.textContent).not.toContain('Accepted')
  })
})
