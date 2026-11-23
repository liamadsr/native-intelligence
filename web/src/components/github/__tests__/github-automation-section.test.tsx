// @vitest-environment jsdom
/**
 * A team's GitHub section (docs/plans/github-reviews.md, phase 2): the
 * switch saves on the team (and goes back when the server refuses), and the
 * workspace's repositories list, with add and remove for owners and admins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))

import { GithubAutomationSection } from '../github-automation-section'

let container: HTMLDivElement
let root: Root
let repos: string[]
let canManage: boolean
let patchOk: boolean
const calls: Array<{ method: string; url: string; body?: unknown }> = []

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  repos = ['acme/app']
  canManage = true
  patchOk = true
  calls.length = 0
  toastError.mockClear()
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })
    if (url.startsWith('/api/account/github/automation')) {
      if (method === 'POST') repos.push((body as { repo: string }).repo.toLowerCase())
      if (method === 'DELETE') repos = repos.filter((r) => !url.endsWith(encodeURIComponent(r)))
      return new Response(JSON.stringify({ repos: repos.map((r) => ({ repo_full_name: r })), canManage }), { status: 200 })
    }
    if (url.startsWith('/api/account/teams/')) {
      return patchOk
        ? new Response(JSON.stringify({ team: { github_automation: (body as { github_automation: boolean }).github_automation } }), { status: 200 })
        : new Response(JSON.stringify({ error: 'no' }), { status: 500 })
    }
    return new Response('{}', { status: 404 })
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const q = (sel: string) => container.querySelector<HTMLElement>(sel)

async function render(enabled = true, onChanged?: (on: boolean) => void) {
  await act(async () => root.render(<GithubAutomationSection teamId="t1" enabled={enabled} onChanged={onChanged} />))
  await settle()
}

describe('GithubAutomationSection', () => {
  it('lists the workspace’s repositories', async () => {
    await render()
    expect(q('[data-github-repo="acme/app"]')).not.toBeNull()
  })

  it('saves the switch on the team', async () => {
    const changed: boolean[] = []
    await render(true, (on) => changed.push(on))
    await act(async () => q('[data-github-automation-switch]')!.click())
    await settle()
    expect(calls).toContainEqual({ method: 'PATCH', url: '/api/account/teams/t1', body: { github_automation: false } })
    expect(changed).toEqual([false])
  })

  it('puts the switch back when the server refuses (a member who is not a lead)', async () => {
    patchOk = false
    await render(true)
    await act(async () => q('[data-github-automation-switch]')!.click())
    await settle()
    expect(q('[data-github-automation-switch]')!.getAttribute('aria-checked')).toBe('true')
    expect(toastError).toHaveBeenCalled()
  })

  it('adds and removes a repository for an owner or admin', async () => {
    await render()
    const input = q('[data-github-repo-input]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Acme/Web')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => q('[data-github-repo-add]')!.click())
    await settle()
    expect(q('[data-github-repo="acme/web"]')).not.toBeNull()
    await act(async () => container.querySelector<HTMLElement>('[aria-label="Remove acme/app"]')!.click())
    await settle()
    expect(q('[data-github-repo="acme/app"]')).toBeNull()
  })

  it('offers no add or remove to anyone else', async () => {
    canManage = false
    await render()
    expect(q('[data-github-repo-input]')).toBeNull()
    expect(container.querySelector('[aria-label="Remove acme/app"]')).toBeNull()
  })
})
