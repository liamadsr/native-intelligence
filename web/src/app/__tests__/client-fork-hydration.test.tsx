// @vitest-environment jsdom
/**
 * A client component rendered by a server layout must be its parent's ONLY
 * child — never one of several siblings.
 *
 * React derives every `useId` from the component's position, and a child in a
 * list of two or more ("forked") adds its slot to the id of everything beneath
 * it. On the client, a client component whose JS chunk has not loaded yet
 * arrives from the RSC payload as a lazy type. When its chunk lands a moment
 * after hydration reaches it (within React's one yield), hydration — a
 * transition in Next.js — REPLAYS the fiber instead of unwinding, and the
 * replay (`resetWorkInProgress`) clears the Forked flag, so the re-run never
 * pushes that slot. The server, which always had the module, did. Every
 * `useId` beneath it then hydrates with an id the server never rendered: an
 * intermittent mismatch that surfaced on the tab strip's gooey filter ids
 * while DashboardErrorBoundary sat beside the hidden page slot in
 * account/(dashboard)/layout.tsx. Reproduced against both the test runner's
 * React and the 19.3 canary Next.js ships.
 *
 * This file reproduces the mechanism; if React ever fixes the replay, the
 * control fails, and the only-child rule can go. The rule itself is pinned in
 * the layouts on the shell's path by client-fork-layout-placement.test.ts — a
 * source test kept out of this jsdom file, where NODE_ENV=production (Vercel's
 * `vitest run`) stubs out node:fs / node:path.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { lazy, startTransition, useEffect, useId, type ComponentType, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { hydrateRoot } from 'react-dom/client'

/** Ids the client committed (effects never run in a server render). */
const clientIds: string[] = []

/** A `useId` consumer beneath the boundary, like the gooey in the tab strip. */
function Probe() {
  const id = useId()
  useEffect(() => {
    clientIds.push(id)
  }, [id])
  return <span data-probe-id={id} />
}

/** Stands in for DashboardErrorBoundary: a client component that renders its children. */
function Boundary({ children }: { children: ReactNode }) {
  return <>{children}</>
}

type Shape = 'beside-siblings' | 'only-child'

function layout(B: ComponentType<{ children: ReactNode }>, shape: Shape) {
  const guarded = (
    <B>
      <Probe />
    </B>
  )
  return shape === 'beside-siblings' ? (
    // The old (dashboard) layout: the boundary and the hidden page slot share one parent.
    <div>
      {guarded}
      <div className="hidden" />
    </div>
  ) : (
    // Today's: the boundary alone in its container, the page slot beside it.
    <>
      <div>{guarded}</div>
      <div className="hidden" />
    </>
  )
}

/**
 * Server-render with the module present; hydrate the way Next.js does — inside
 * a transition (app-index.js) — with the boundary's chunk arriving the way a
 * React Flight client-reference chunk does: status-tracked, and landing just
 * after hydration first reaches it. React suspends, yields once, sees the chunk
 * `fulfilled`, and REPLAYS the fiber instead of unwinding. (A chunk that lands
 * later is unwound and re-rendered from scratch, which never shows the bug —
 * hence the intermittency in the app.)
 */
async function hydrateWithLateChunk(shape: Shape) {
  clientIds.length = 0
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

  const container = document.createElement('div')
  container.innerHTML = renderToString(layout(Boundary, shape))
  document.body.appendChild(container)
  const server = container.querySelector('span')?.getAttribute('data-probe-id') ?? undefined

  const chunk: Promise<{ default: typeof Boundary }> & { status?: string; value?: unknown } =
    Promise.resolve({ default: Boundary })
  chunk.status = 'pending'
  void chunk.then((value) => {
    chunk.status = 'fulfilled'
    chunk.value = value
  })
  let root!: ReturnType<typeof hydrateRoot>
  startTransition(() => {
    root = hydrateRoot(container, layout(lazy(() => chunk), shape), {
      onRecoverableError: () => {},
    })
  })
  // Hydration is a time-sliced transition that yields to the event loop, and the
  // probe's effect flushes in a later task still. Wait for that commit itself: on
  // a loaded runner (Vercel's full-suite build) it takes far longer than any fixed
  // delay. Any mismatch is reported before it (render phase, ahead of the commit).
  await vi.waitFor(
    () => {
      if (clientIds.length === 0) throw new Error('hydration has not committed the probe yet')
    },
    { timeout: 20_000, interval: 5 },
  )

  const mismatchReported = consoleError.mock.calls.some((args) =>
    String(args[0]).includes("didn't match the client properties"),
  )
  root.unmount()
  container.remove()
  return { server, client: clientIds.at(-1), mismatchReported }
}

afterEach(() => {
  vi.restoreAllMocks()
})

/** Above the commit wait, so a hydration that never commits fails with its message. */
const TEST_TIMEOUT_MS = 30_000

describe('a client component whose chunk is still loading when hydration reaches it', () => {
  it('control: beside siblings, the useIds beneath it hydrate with ids the server never rendered', async () => {
    const result = await hydrateWithLateChunk('beside-siblings')
    expect(result.server).toBeDefined()
    expect(result.client).toBeDefined()
    expect(result.client).not.toBe(result.server)
    expect(result.mismatchReported).toBe(true)
  }, TEST_TIMEOUT_MS)

  it("as its parent's only child, they hydrate exactly as the server rendered them", async () => {
    const result = await hydrateWithLateChunk('only-child')
    expect(result.server).toBeDefined()
    expect(result.client).toBe(result.server)
    expect(result.mismatchReported).toBe(false)
  }, TEST_TIMEOUT_MS)
})
