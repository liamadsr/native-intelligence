// @vitest-environment jsdom
/**
 * The side panel's computer card (computer-section.tsx) and its summary: named
 * after the assistant, its state in a line, the page's preview (dimmed while
 * asleep), opening the live view; without a computer, a row that starts one; the agent's
 * bot's state and status (agentBotState, agentSummary).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { vi } from 'vitest'
import { ComputerSection, NOT_SET_UP, NOT_SET_UP_NO_VIEW, agentBotState, agentSummary, macSummary } from '../computer-section'
import { __resetComputerForTests, computerSummary, getComputer, type ComputerState } from '@/lib/cloud-browser/computer-client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const computer = (over: Partial<ComputerState> = {}): ComputerState => ({ exists: true, status: 'running', driver: 'agent', busy: false,
  liveView: true, thumbnail: null, viewOpen: false, viewEpoch: 0, macConnected: false, mac: null, ...over })

let root: Root
let host: HTMLElement
beforeEach(() => { __resetComputerForTests(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('computerSummary', () => {
  it('says what the computer is doing, and nothing without one', () => {
    expect(computerSummary(computer())).toBe('Ready')
    expect(computerSummary(computer({ busy: true }))).toBe('Working')
    expect(computerSummary(computer({ driver: 'person' }))).toBe('You’re driving')
    expect(computerSummary(computer({ status: 'starting' }))).toBe('Waking…')
    expect(computerSummary(computer({ status: 'stopped' }))).toBe('Asleep')
    expect(computerSummary(computer({ exists: false }))).toBeNull()
    expect(computerSummary(computer({ exists: null, status: null }))).toBeNull()
  })
})

describe('agentBotState and agentSummary', () => {
  it('the agent at work while it works its computer, else awake and Active: never asleep, whatever its computer does', () => {
    expect(agentBotState(computer())).toBe('default')
    expect(agentSummary(computer())).toBe('Active')
    expect(agentBotState(computer({ busy: true }))).toBe('working')
    expect(agentSummary(computer({ busy: true }))).toBe('Working')
    // The person driving: the agent isn't working it.
    expect(agentBotState(computer({ busy: true, driver: 'person' }))).toBe('default')
    for (const status of ['starting', 'stopping', 'stopped'] as const) {
      expect(agentBotState(computer({ status, busy: true }))).toBe('default')
      expect(agentSummary(computer({ status }))).toBe('Active')
    }
  })
})

describe('the computer card', () => {
  it('names the assistant’s computer, shows its state and preview, and opens the live view', () => {
    act(() => root.render(<ComputerSection computer={computer({ busy: true, thumbnail: 'blob:frame' })} name="Joseph" />))
    // Under the agent's own row, as Dots' agent card.
    expect(host.querySelector('[data-computer-section] > p')!.textContent).toBe('Computers')
    expect(host.textContent).toContain('Joseph’s computer')
    expect(host.querySelector('[data-computer-state]')!.textContent).toBe('Working')
    const preview = host.querySelector<HTMLImageElement>('[data-computer-preview]')!
    expect(preview.src).toBe('blob:frame')
    expect(preview.className).not.toContain('grayscale')
    act(() => host.querySelector<HTMLButtonElement>('[data-computer-open]')!.click())
    expect(getComputer().viewOpen).toBe(true)
  })

  it('dims the last frame while the computer sleeps', () => {
    act(() => root.render(<ComputerSection computer={computer({ status: 'stopped', thumbnail: 'blob:last' })} name="Joseph" />))
    expect(host.querySelector('[data-computer-preview]')!.className).toContain('grayscale')
    expect(host.querySelector('[data-computer-state]')!.textContent).toBe('Asleep')
  })

  it('without a computer yet, says so and a click opens the live view (which starts it)', () => {
    act(() => root.render(<ComputerSection computer={computer({ exists: false, status: null })} name="Joseph" />))
    expect(host.textContent).toContain('Joseph’s computer')
    expect(host.querySelector('[data-computer-state]')!.textContent).toBe(NOT_SET_UP)
    expect(host.querySelector('[data-computer-preview]')).toBeNull()
    const open = host.querySelector<HTMLButtonElement>('[data-computer-open]')!
    expect(open.disabled).toBe(false)
    act(() => open.click())
    expect(getComputer().viewOpen).toBe(true)
  })

  it('without a computer and no live view on this server, doesn’t offer to start one', () => {
    act(() => root.render(<ComputerSection computer={computer({ exists: false, status: null, liveView: false })} name="Joseph" />))
    expect(host.querySelector('[data-computer-state]')!.textContent).toBe(NOT_SET_UP_NO_VIEW)
    expect(host.querySelector<HTMLButtonElement>('[data-computer-open]')!.disabled).toBe(true)
  })

  it('before the first read, no line yet', () => {
    act(() => root.render(<ComputerSection computer={computer({ exists: null, status: null })} name="Joseph" />))
    expect(host.querySelector('[data-computer-state]')!.textContent).toBe('')
  })

  it('opens nothing where the live view isn’t set up, without a note about it', () => {
    act(() => root.render(<ComputerSection computer={computer({ liveView: false })} name="Joseph" />))
    expect(host.querySelector<HTMLButtonElement>('[data-computer-open]')!.disabled).toBe(true)
    expect(host.textContent).not.toContain('isn’t set up')
  })
})

describe('the Mac row (C4)', () => {
  const mac = (fields: Record<string, unknown>) => ({ state: 'up', needsToken: false, sitesToday: [], ...fields }) as ComputerState['mac']

  it('says what this Mac is doing on the desktop, and nothing while it is off', () => {
    expect(macSummary(computer({ mac: mac({ sitesToday: [{ host: 'resy.com', count: 3 }] }) }))).toEqual({ label: 'This Mac', state: 'Connected · 1 site today' })
    expect(macSummary(computer({ mac: mac({ state: 'down' }) }))?.state).toBe('Connecting…')
    expect(macSummary(computer({ mac: mac({ state: 'off' }) }))).toBeNull()
  })

  it('elsewhere, says a Mac carries it only while it does', () => {
    expect(macSummary(computer({ macConnected: true }))).toEqual({ label: 'Your Mac', state: 'Connected' })
    expect(macSummary(computer({ macConnected: true, status: 'stopped' }))).toBeNull()
    expect(macSummary(computer())).toBeNull()
  })

  it('has no switch: a status line only (the agent uses the person’s network whenever this Mac is online)', () => {
    act(() => root.render(<ComputerSection computer={computer({ mac: mac({}) })} name="Joseph" />))
    expect(host.querySelector('[data-computer-mac-state]')!.textContent).toBe('Connected')
    expect(host.querySelector('[data-computer-mac] button, [role="switch"]')).toBeNull()
  })
})
