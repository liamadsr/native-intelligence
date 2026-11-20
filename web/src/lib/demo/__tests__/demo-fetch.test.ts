/**
 * @vitest-environment jsdom
 *
 * The demo data layer answers a workspace's requests on a public page, and
 * must never answer one inside the app or outlive the demo that installed it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { demoAnswer, installDemoFetch, isDemoRequest } from '../demo-fetch'

const DEMO_CONTACT_ID = 'demo-contact'
const SNAPSHOT = { [`/api/account/contacts/${DEMO_CONTACT_ID}`]: { contact: { full_name: 'Lena Park' } } }

const ORIGIN = window.location.origin

describe('isDemoRequest', () => {
  it('takes the workspace’s requests on a public page', () => {
    expect(isDemoRequest('/', ORIGIN, '/api/account/contacts/1')).toBe(true)
    expect(isDemoRequest('/features/crm', ORIGIN, `${ORIGIN}/api/account/companies`)).toBe(true)
  })

  it('leaves every other request alone', () => {
    expect(isDemoRequest('/', ORIGIN, '/api/sky?tz=UTC')).toBe(false)
    expect(isDemoRequest('/demo/app', ORIGIN, '/api/oauth/status')).toBe(true)
    expect(isDemoRequest('/', ORIGIN, '/api/accounting')).toBe(false)
    expect(isDemoRequest('/', ORIGIN, 'https://elsewhere.example/api/account/contacts/1')).toBe(false)
  })

  it('never answers inside the app', () => {
    expect(isDemoRequest('/account', ORIGIN, '/api/account/contacts/1')).toBe(false)
    expect(isDemoRequest('/account/crm', ORIGIN, '/api/account/contacts/1')).toBe(false)
    expect(isDemoRequest('/admin/users', ORIGIN, '/api/account/contacts/1')).toBe(false)
  })
})

describe('demoAnswer', () => {
  const snapshots = [{ '/api/account/a?x=1': 'exact', '/api/account/a': 'path' }]
  it('prefers the path with its query, then the path alone', () => {
    expect(demoAnswer(snapshots, '/api/account/a?x=1')).toEqual({ found: true, body: 'exact' })
    expect(demoAnswer(snapshots, '/api/account/a?x=2')).toEqual({ found: true, body: 'path' })
    expect(demoAnswer(snapshots, '/api/account/b')).toEqual({ found: false, body: {} })
  })
})

describe('demoAnswer for a list the app reads with a POST', () => {
  const snapshots = [{ 'POST /api/account/views/query#{"a":1}': 'exact', 'POST /api/account/views/query': 'path' }]
  it('prefers the same request body, then the path', () => {
    expect(demoAnswer(snapshots, '/api/account/views/query', { body: '{"a":1}' })).toEqual({ found: true, body: 'exact' })
    expect(demoAnswer(snapshots, '/api/account/views/query', { body: '{"a":2}' })).toEqual({ found: true, body: 'path' })
    expect(demoAnswer(snapshots, '/api/account/other', { body: '' })).toEqual({ found: false, body: {} })
  })
  it('never answers a GET with a POST’s answer', () => {
    expect(demoAnswer(snapshots, '/api/account/views/query').found).toBe(false)
  })
})

describe('installDemoFetch', () => {
  const server = vi.fn(async () => new Response('from the server'))
  afterEach(() => {
    server.mockClear()
    window.history.replaceState(null, '', '/')
  })

  it('answers from the snapshot, changes nothing, and puts the real fetch back', async () => {
    window.fetch = server as unknown as typeof window.fetch
    const before = window.fetch
    const socketBefore = window.WebSocket
    const remove = installDemoFetch(SNAPSHOT)

    // No live connection while a demo is up: a socket never connects, and sends nothing.
    expect(window.WebSocket).not.toBe(socketBefore)
    const socket = new WebSocket('wss://database.example/realtime')
    expect(socket.readyState).toBe(WebSocket.CONNECTING)
    socket.send('ignored')
    socket.close()
    expect(socket.readyState).toBe(WebSocket.CLOSED)

    const res = await fetch(`/api/account/contacts/${DEMO_CONTACT_ID}`)
    expect((await res.json()).contact.full_name).toBe('Lena Park')

    const unknown = await fetch('/api/account/not-saved')
    expect(await unknown.json()).toEqual({})
    expect(window.__demoMisses).toEqual(['/api/account/not-saved'])

    const write = await fetch(`/api/account/contacts/${DEMO_CONTACT_ID}`, { method: 'DELETE' })
    expect(await write.json()).toEqual({})
    // A POST nobody recorded changes nothing and is not counted as missing.
    const post = await fetch('/api/account/contacts', { method: 'POST', body: '{"name":"x"}' })
    expect(await post.json()).toEqual({})
    expect(window.__demoMisses).toEqual(['/api/account/not-saved'])

    await fetch('/api/sky')
    expect(server).toHaveBeenCalledTimes(1)

    // A visitor who signs in and lands in the app gets the real server.
    window.history.replaceState(null, '', '/account')
    await fetch(`/api/account/contacts/${DEMO_CONTACT_ID}`)
    expect(server).toHaveBeenCalledTimes(2)

    remove()
    expect(window.fetch).toBe(before)
    expect(window.WebSocket).toBe(socketBefore)
  })

  it('stays until the last demo on the page is gone', () => {
    window.fetch = server as unknown as typeof window.fetch
    const before = window.fetch
    const first = installDemoFetch({})
    const second = installDemoFetch({})
    first()
    expect(window.fetch).not.toBe(before)
    second()
    expect(window.fetch).toBe(before)
  })
})
