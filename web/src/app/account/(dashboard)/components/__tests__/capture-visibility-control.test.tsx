// @vitest-environment jsdom
/**
 * The capture scope control — "Workspace" vs "Only me".
 *
 * The control owns the write, so it also owns the two things a write can do
 * wrong. It applies the new scope OPTIMISTICALLY (the trigger's icon and label
 * flip before the round trip) and must therefore hand the OLD value back on any
 * failure — otherwise the panel says "Only me" over a capture the whole
 * workspace can still read, which is the worst possible lie for this particular
 * feature. A 403 (someone who isn't the creator) is the same story with a
 * server-supplied message.
 *
 * `useCaptureVisibilityViewer` is tested alongside it because it is what
 * gates the control's existence: it bridges member id → auth uid (captures
 * are keyed on the uid) and reports the member count that decides whether
 * "who can see this" is even a meaningful question.
 *
 * The control renders a shadcn/Radix `Select` pill (styled to match the mail
 * folder selector). Radix's Select needs pointer APIs jsdom does not implement,
 * so — following the convention already used by proposal-card-lens and friends
 * — `@/components/ui/select` is swapped for a plain-div stand-in that keeps the
 * two things these tests read: the trigger's rendered content, and a clickable
 * item per option carrying its `value`. What survives unchanged is everything
 * that matters here: which value gets chosen, what the component does with it,
 * and what the user is left reading.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useState, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (m: string) => toastError(m) } }))

const cachedJson = vi.fn()
vi.mock('@/lib/cached-fetch', () => ({ cachedJson: (...a: unknown[]) => cachedJson(...a) }))

vi.mock('@/components/ui/select', async () => {
  const { createElement: e, createContext, useContext } = await import('react')
  const Ctx = createContext<{ value?: string; onValueChange?: (v: string) => void }>({})
  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value?: string
      onValueChange?: (v: string) => void
      children?: ReactNode
    }) => e(Ctx.Provider, { value: { value, onValueChange } }, e('div', { 'data-select': value }, children)),
    SelectTrigger: ({
      'aria-label': ariaLabel,
      title,
      children,
    }: {
      'aria-label'?: string
      title?: string
      children?: ReactNode
    }) => e('div', { 'data-select-trigger': ariaLabel, 'data-title': title }, children),
    SelectValue: () => null,
    SelectContent: ({ children }: { children?: ReactNode }) => e('div', { role: 'listbox' }, children),
    SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => {
      const { onValueChange } = useContext(Ctx)
      return e(
        'div',
        { role: 'option', 'data-value': value, onClick: () => onValueChange?.(value) },
        children,
      )
    },
  }
})

import {
  CaptureVisibilityControl,
  canOfferVisibilityControl,
  useCaptureVisibilityViewer,
  type CaptureVisibility,
} from '../capture-visibility-control'
import { VisibilityControl, useVisibilityViewer } from '../visibility-control'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  toastError.mockClear()
  cachedJson.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** Drives the control the way the panel does: parent owns the value. */
function Harness({ initial = 'workspace' as CaptureVisibility, onChange = vi.fn() }) {
  const [visibility, setVisibility] = useState<CaptureVisibility>(initial)
  return h(CaptureVisibilityControl, {
    captureId: 'cap-1',
    visibility,
    onVisibilityChange: (v: CaptureVisibility) => {
      setVisibility(v)
      onChange(v)
    },
  })
}

/** The scope the Select is currently bound to — what Radix would mark checked. */
function selectedValue(): string | null {
  const el = container.querySelector<HTMLElement>('[data-select]')
  if (!el) throw new Error('no scope select rendered')
  return el.getAttribute('data-select')
}

function options(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
}

/** The pill itself — what the header shows without opening anything. */
function trigger(): HTMLElement {
  const el = container.querySelector<HTMLElement>(
    '[data-select-trigger="Change who can see this capture"]',
  )
  if (!el) throw new Error('no scope trigger rendered')
  return el
}

/** Picks a scope from the dropdown, by the label the user reads. */
async function choose(label: string) {
  const option = options().find((o) => o.textContent?.includes(label))
  if (!option) throw new Error(`no option labelled "${label}"`)
  await act(async () => {
    option.click()
  })
}

async function render(node: React.ReactElement) {
  await act(async () => {
    root.render(node)
  })
}

describe('CaptureVisibilityControl', () => {
  it('PATCHes the dedicated route with the picked scope', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    await render(h(Harness))
    await choose('Only me')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    // The dedicated route — NOT the general capture PATCH, which rejects the field.
    expect(url).toBe('/api/account/captures/cap-1/visibility')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ visibility: 'private' })
  })

  it('applies the new scope OPTIMISTICALLY, before the request settles', async () => {
    let release: (v: unknown) => void = () => {}
    const pending = new Promise((r) => { release = r })
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending))
    const onChange = vi.fn()

    await render(h(Harness, { onChange }))
    await choose('Only me')

    // Parent already told, request still in flight — and the pill has already
    // relabelled itself.
    expect(onChange).toHaveBeenCalledWith('private')
    expect(trigger().textContent).toContain('Only me')
    expect(trigger().getAttribute('data-title')).toBe('Only you can see this capture.')

    await act(async () => {
      release({ ok: true, json: async () => ({}) })
      await pending
    })
  })

  it('ROLLS BACK and explains itself when the write fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'Only the creator can change visibility' }) }),
    )
    const onChange = vi.fn()

    await render(h(Harness, { onChange }))
    await choose('Only me')

    // Optimistic flip, then the flip back — the parent must end on the old value.
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['private', 'workspace'])
    expect(toastError).toHaveBeenCalledWith('Only the creator can change visibility')
    // …and the pill the user is left looking at is the workspace one.
    expect(trigger().textContent).toContain('Workspace')
    expect(trigger().getAttribute('data-title')).toBe(
      'Everyone in this workspace can see this capture.',
    )
    expect(selectedValue()).toBe('workspace')
  })

  it('rolls back on a NETWORK failure too, with a generic message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const onChange = vi.fn()

    await render(h(Harness, { onChange }))
    await choose('Only me')

    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['private', 'workspace'])
    expect(toastError).toHaveBeenCalledWith('offline')
  })

  it('does not re-write the scope it is already on', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    await render(h(Harness))
    await choose('Workspace')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows the CURRENT scope on the pill, and both scopes to pick from', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await render(h(Harness, { initial: 'private' as CaptureVisibility }))

    // The trigger states where the capture stands right now…
    expect(trigger().textContent).toContain('Only me')
    expect(selectedValue()).toBe('private')
    // …and the dropdown offers both, each with its own explanation line.
    const items = options()
    expect(items.map((o) => o.getAttribute('data-value'))).toEqual(['workspace', 'private'])
    expect(items[0].textContent).toContain('Workspace')
    expect(items[0].textContent).toContain('Everyone in this workspace can see this capture.')
    expect(items[1].textContent).toContain('Only me')
    expect(items[1].textContent).toContain('Only you can see this capture.')
  })
})

describe('canOfferVisibilityControl', () => {
  it('offers it to the creator of a workspace capture', () => {
    expect(canOfferVisibilityControl('u-me', 'workspace', 'u-me', 3)).toBe(true)
  })

  it('withholds it from a teammate who is merely reading the capture', () => {
    expect(canOfferVisibilityControl('u-other', 'workspace', 'u-me', 3)).toBe(false)
  })

  it('withholds it in a SOLO workspace, creator or not', () => {
    // "Only me" is already the state of the world; the control would be a
    // switch with nothing on the other side of it.
    expect(canOfferVisibilityControl('u-me', 'workspace', 'u-me', 1)).toBe(false)
    expect(canOfferVisibilityControl('u-me', 'private', 'u-me', 1)).toBe(false)
  })

  it('withholds it until the viewer’s own id is known', () => {
    expect(canOfferVisibilityControl('u-me', 'workspace', null, 3)).toBe(false)
  })

  it('OFFERS IT on an already-private capture whose owner the payload omits', () => {
    // Reading a private capture is itself proof of authorship — RLS and the
    // detail route only ever serve one to its creator. Without this, a capture
    // made private on a payload lacking `user_id` could never be made public
    // again from the UI: a one-way door.
    expect(canOfferVisibilityControl(undefined, 'private', 'u-me', 3)).toBe(true)
    expect(canOfferVisibilityControl(null, 'private', 'u-me', 3)).toBe(true)
  })

  it('withholds it on a WORKSPACE capture whose owner the payload omits', () => {
    // Here reading proves nothing — every member can read it — so offering the
    // control would hand most of the workspace a button that 403s.
    expect(canOfferVisibilityControl(undefined, 'workspace', 'u-me', 3)).toBe(false)
  })

  it('lets an explicit owner id OVERRIDE the private-implies-mine shortcut', () => {
    // Belt and braces: if the payload does say who owns it, that answer wins
    // even for a private capture.
    expect(canOfferVisibilityControl('u-other', 'private', 'u-me', 3)).toBe(false)
  })

  it('withholds it while the member count is still unknown', () => {
    expect(canOfferVisibilityControl('u-me', 'workspace', 'u-me', null)).toBe(false)
  })
})

describe('useCaptureVisibilityViewer', () => {
  function Probe({ workspaceId }: { workspaceId: string | null }) {
    const { userId, memberCount } = useCaptureVisibilityViewer(workspaceId)
    return h('div', null, `${userId ?? 'none'}|${memberCount ?? 'none'}`)
  }

  it('resolves the viewer’s AUTH uid via their member row', async () => {
    // captures.user_id is a uid; the workspace cache context only exposes the
    // MEMBER id, so the members list is the bridge. Getting this wrong would
    // compare a member id to a uid and hide the control from every creator.
    cachedJson.mockResolvedValue({
      currentMemberId: 'm-2',
      members: [
        { id: 'm-1', user_id: 'u-1' },
        { id: 'm-2', user_id: 'u-2' },
      ],
    })
    await render(h(Probe, { workspaceId: 'ws-1' }))
    expect(container.textContent).toBe('u-2|2')
    expect(cachedJson).toHaveBeenCalledWith('/api/account/workspace', { scope: 'ws-1' })
  })

  it('reports a solo workspace, so the caller can hide a pointless control', async () => {
    cachedJson.mockResolvedValue({
      currentMemberId: 'm-1',
      members: [{ id: 'm-1', user_id: 'u-1' }],
    })
    await render(h(Probe, { workspaceId: 'ws-1' }))
    expect(container.textContent).toBe('u-1|1')
  })

  it('stays null when the payload cannot be read (control simply never shows)', async () => {
    cachedJson.mockResolvedValue(null)
    await render(h(Probe, { workspaceId: 'ws-1' }))
    expect(container.textContent).toBe('none|none')
  })

  it('leaves the uid null when the member row is missing from the list', async () => {
    cachedJson.mockResolvedValue({ currentMemberId: 'm-9', members: [{ id: 'm-1', user_id: 'u-1' }] })
    await render(h(Probe, { workspaceId: 'ws-1' }))
    expect(container.textContent).toBe('none|1')
  })
})

// Documents use the same control (migration 369): same pill, same options, the
// noun and the route are all that differ.
describe('VisibilityControl for a document', () => {
  function DocHarness({ onChange = vi.fn() }) {
    const [visibility, setVisibility] = useState<CaptureVisibility>('workspace')
    return h(VisibilityControl, {
      noun: 'document',
      endpoint: '/api/account/documents/doc-1/visibility',
      visibility,
      onVisibilityChange: (v: CaptureVisibility) => {
        setVisibility(v)
        onChange(v)
      },
    })
  }

  it('PATCHes the document route and speaks of the document', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    await render(h(DocHarness))
    const pill = container.querySelector<HTMLElement>('[data-select-trigger="Change who can see this document"]')
    expect(pill?.getAttribute('data-title')).toBe('Everyone in this workspace can see this document.')
    expect(options().map((o) => o.textContent)).toEqual([
      'WorkspaceEveryone in this workspace can see this document.',
      'Only meOnly you can see this document.',
    ])

    await choose('Only me')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/account/documents/doc-1/visibility')
    expect(JSON.parse(init.body)).toEqual({ visibility: 'private' })
    expect(container.querySelector('[data-select-trigger]')?.getAttribute('data-title')).toBe('Only you can see this document.')
  })

  it("the viewer hook also hands back the member id (a document's creator is a member)", async () => {
    cachedJson.mockResolvedValue({ currentMemberId: 'm-2', members: [{ id: 'm-1', user_id: 'u-1' }, { id: 'm-2', user_id: 'u-2' }] })
    let seen: ReturnType<typeof useVisibilityViewer> | null = null
    function Probe() {
      seen = useVisibilityViewer('ws-1')
      return null
    }
    await render(h(Probe))
    expect(seen).toEqual({ userId: 'u-2', memberId: 'm-2', memberCount: 2 })
  })
})
