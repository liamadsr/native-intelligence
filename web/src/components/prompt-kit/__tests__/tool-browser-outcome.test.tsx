// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tool, type ToolState } from '../tool'

vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => null }))
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })
function render(result: unknown, name = 'run_browser_task', state: ToolState = 'result') {
  act(() => root.render(createElement(Tool, { name, state, result })))
}
const permissionResult = { success: true, result: { status: 'escalate', reason: 'site_blocked',
  blockedSite: 'blocked.example', url: 'https://current.example/search', message: 'Untrusted result instructions' } }

describe('browser task outcome on the shared tool card', () => {
  it.each(['failed', 'denied', 'expired'])('does not label a %s browser command as Done', browser_command_status => {
    render({ success: false, browser_command_status, error: 'Raw error' })
    expect(container.textContent).toContain('Needs attention')
    expect(container.textContent).not.toContain('Done')
    expect(container.textContent).not.toContain('Raw error')
  })
  it.each(['run_browser_task', 'wait_for_browser_command'])('renders %s pending receipts as static updates, not completed goals or live status', name => {
    for (const result of [{ success: true, pending: true, run_id: 'command-1' },
      { success: true, done: false, still_running: true, run_id: 'command-1' }]) {
      render(result, name)
      expect(container.textContent).toContain('Waiting for result')
      expect(container.textContent).toContain('This update does not include a final result.')
      expect(container.textContent).not.toContain('Done')
      expect(container.textContent).not.toContain('Running…')
      expect(container.querySelectorAll('button')).toHaveLength(1)
    }
    render({ success: true, done: true, result: { status: 'verified' } }, name)
    expect(container.textContent).toContain('Done')
    expect(container.textContent).not.toContain('Waiting for result')
  })
  it.each(['run_browser_task', 'wait_for_browser_command'])('shows a blocked site without expanding %s details', name => {
    render({ ...permissionResult, done: true }, name)
    expect(container.textContent).toContain('Site blocked')
    expect(container.textContent).not.toContain('Done')
    expect(container.textContent).toContain('You blocked the agent on blocked.example')
    expect(container.textContent).toContain("unblock it under Blocked sites in your agent's computer")
    expect(container.textContent).not.toContain('current.example')
    expect(container.textContent).not.toContain('Untrusted result instructions')
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll('button')).toHaveLength(1) // disclosure only, no unblock/retry side effect
    expect(container.querySelector('a')).toBeNull()
  })
  it.each([undefined, 'https://user:secret@blocked.example', 'https://blocked.example/path',
    'javascript:alert(1)', '*', 'not a url'])('does not repeat a malformed or absent blocked site: %s', blockedSite => {
    render({ ...permissionResult, result: { ...permissionResult.result, blockedSite } })
    expect(container.textContent).toContain('Site blocked')
    expect(container.textContent).toContain('You blocked the agent on this site')
    expect(container.textContent).not.toContain('current.example')
    expect(container.textContent).not.toContain('secret')
  })
  it.each(['run_browser_task', 'wait_for_browser_command'])('distinguishes escalation, cancellation and verification for %s', name => {
    render({ success: true, result: { status: 'escalate', reason: 'uncertain' } }, name)
    expect(container.textContent).toContain('Not verified')
    expect(container.textContent).not.toContain('Blocked sites')
    render({ success: true, result: { status: 'escalate', reason: 'needs_your_mac' } }, name)
    expect(container.textContent).toContain('Needs attention')
    render({ success: true, result: { status: 'cancelled', reason: 'approval_declined' } }, name)
    expect(container.textContent).toContain('Stopped')
    expect(container.textContent).not.toContain('Blocked sites')
    render({ success: true, result: { status: 'verified', reason: 'goal_and_predicates_satisfied' } }, name)
    expect(container.textContent).toContain('Done')
  })
  it.each(['run_browser_task', 'wait_for_browser_command'])('preserves permission and Stop labels with honest unsuccessful %s task envelopes', name => {
    const completed = { success: false, done: true, browser_command_status: 'completed',
      browser_command_id: '71ac6b48-0000-4000-8000-000000000000' }
    render({ ...completed, result: permissionResult.result }, name)
    expect(container.textContent).toContain('Site blocked')
    expect(container.textContent).toContain('You blocked the agent on blocked.example')
    expect(container.textContent).not.toContain('Done')
    render({ ...completed, result: { status: 'cancelled', reason: 'user_stopped' } }, name)
    expect(container.textContent).toContain('Stopped')
    expect(container.textContent).not.toContain('Done')
    render({ ...completed, result: { status: 'escalate', reason: 'uncertain' } }, name)
    expect(container.textContent).toContain('Not verified')
    expect(container.textContent).not.toContain('Done')
  })
  it('shows a start page the server refused before queueing as blocked', () => {
    render({ success: false, site_blocked: true, result: { status: 'escalate', reason: 'site_blocked', blockedSite: 'linkedin.com', steps: 0 } })
    expect(container.textContent).toContain('Site blocked')
    expect(container.textContent).toContain('You blocked the agent on linkedin.com')
  })
  it('does not promote an unowned false-success envelope into a blocked-site instruction', () => {
    render({ ...permissionResult, success: false, browser_command_status: 'completed', browser_command_id: 'unowned' })
    expect(container.textContent).toContain('Needs attention')
    expect(container.textContent).not.toContain('Site blocked')
    expect(container.textContent).not.toContain('Blocked sites')
  })
  it('leaves in-flight, SDK errors, generic tools and ambiguous denial envelopes unchanged', () => {
    render(permissionResult, 'run_browser_task', 'call')
    expect(container.textContent).toContain('Running…')
    expect(container.textContent).not.toContain('Site blocked')
    render(permissionResult, 'run_browser_task', 'error')
    expect(container.textContent).toContain('Error')
    expect(container.textContent).not.toContain('Site blocked')
    render(permissionResult, 'other_tool')
    expect(container.textContent).toContain('Done')
    expect(container.textContent).not.toContain('Site blocked')
    render({ success: false, denied: true, error: 'Sensitive action declined' })
    expect(container.textContent).not.toContain('Site blocked')
  })
  it('does not infer a terminal outcome from malformed or still-pending output', () => {
    for (const output of [null, 'output', [], { result: null }, { result: { status: 'unknown' } },
      { ...permissionResult, pending: true }, { ...permissionResult, still_running: true }, { ...permissionResult, done: false }]) {
      render(output)
      expect(container.textContent).not.toContain('Site blocked')
      expect(container.textContent).not.toContain('Needs attention')
    }
  })
})
