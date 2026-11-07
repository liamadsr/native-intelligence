// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useBackdropMotionKind, type BackdropMotionKind } from '../sky-gate'
import { GLASS_WINDOW_UNSUPPORTED_ATTR } from '@/lib/window-backdrop'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const html = () => document.documentElement
let seen: BackdropMotionKind | null = null
let host: HTMLDivElement
let root: Root

function Probe() {
  seen = useBackdropMotionKind()
  return null
}

beforeEach(async () => {
  html().removeAttribute(GLASS_WINDOW_UNSUPPORTED_ATTR)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function kindFor(bg: string): Promise<BackdropMotionKind | null> {
  html().setAttribute('data-app-bg', bg)
  await act(async () => root.render(<Probe />))
  return seen
}

describe('useBackdropMotionKind', () => {
  it('runs the sky on Sky, the dots on a flat background', async () => {
    expect(await kindFor('sky')).toBe('sky')
    expect(await kindFor('none')).toBe('dots')
  })

  it('runs nothing behind Glass: the window is see-through', async () => {
    expect(await kindFor('glass')).toBe('none')
  })

  it('shows the Sky in Glass’s place on a desktop too old for it', async () => {
    expect(await kindFor('glass')).toBe('none')
    await act(async () => html().setAttribute(GLASS_WINDOW_UNSUPPORTED_ATTR, ''))
    expect(seen).toBe('sky')
  })
})
