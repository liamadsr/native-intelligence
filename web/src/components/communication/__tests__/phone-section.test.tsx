// @vitest-environment jsdom
/**
 * Adding a phone (phone-section.tsx): the number formatted as it's typed
 * behind a fixed +1, Send code only once it's whole and the consent is
 * ticked; then six boxes that take a paste and check the code at once, a
 * wrong code cleared for another go, Resend after 30 s, Change number; then
 * the linked phone. The routes are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NUMBER_RETRY_MS, PhoneSection, RESEND_AFTER_S } from '../phone-section'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let linked: { number: string; masked: string; verifiedAt: string; optedOut: boolean } | null
let goodCode: string
// The agent's own number (POST /api/account/agent-number), and whether this Dial8 can give one.
let own: string | null
let canGet: boolean
const calls: Array<{ url: string; method: string; body: unknown }> = []
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET'
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  calls.push({ url, method, body })
  if (url === '/api/account/phone' && method === 'GET') {
    return Response.json({ phone: linked, dial8Number: own ?? '+15550000000', agentNumber: own, canGetNumber: canGet && !own, available: true })
  }
  if (url === '/api/account/agent-number' && method === 'POST') {
    own = '+16465550199'
    return Response.json({ number: own })
  }
  if (url === '/api/account/phone' && method === 'POST') return Response.json({ phone: body.phone, masked: '+1 ••• ••• 1234', expiresAt: '2026-10-24T21:00:00Z' })
  if (url === '/api/account/phone' && method === 'PATCH') {
    return Response.json({ alertsOn: true })
  }
  if (url === '/api/account/phone/verify') {
    if (body.code !== goodCode) return Response.json({ error: "That code doesn't match. Check the text and try again." }, { status: 400 })
    linked = { number: '+14155551234', masked: '+1 ••• ••• 1234', verifiedAt: '2026-10-24', optedOut: false }
    return Response.json({ phone: '+14155551234', masked: '+1 ••• ••• 1234' })
  }
  return new Response('{}', { status: 404 })
})

let root: Root
let host: HTMLElement
beforeEach(() => {
  linked = null
  goodCode = '123456'
  own = null
  canGet = false
  calls.length = 0
  vi.stubGlobal('fetch', fetchMock)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel)
async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => void (await Promise.resolve()))
}
async function until(ready: () => boolean) {
  for (let i = 0; i < 200 && !ready(); i++) await act(async () => void (await new Promise((r) => setTimeout(r, 5))))
  expect(ready()).toBe(true)
}
/** What a person's typing or paste leaves in a field, as React sees it. */
async function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function paste(input: HTMLInputElement, text: string) {
  await act(async () => {
    const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: { getData: () => string } }
    event.clipboardData = { getData: () => text }
    input.dispatchEvent(event)
  })
}
const numberField = () => q<HTMLInputElement>('[data-phone-number]')!
const codeField = () => q<HTMLInputElement>('[data-code-field]')!
const boxes = () => [...host.querySelectorAll('[data-code-box]')].map((b) => b.textContent)

async function mountToNumber() {
  await act(async () => root.render(<PhoneSection compact />))
  await until(() => !!q('[data-phone-step="number"]'))
}
async function toCodeStep() {
  await mountToNumber()
  await type(numberField(), '4155551234')
  await act(async () => q<HTMLButtonElement>('[data-sms-consent]')!.closest('label')!.querySelector<HTMLButtonElement>('button')!.click())
  await act(async () => q<HTMLButtonElement>('[data-phone-send]')!.click())
  await until(() => !!q('[data-phone-step="code"]'))
}

describe('adding a phone', () => {
  it('formats the number as it’s typed or pasted, behind a fixed +1', async () => {
    await mountToNumber()
    expect(host.textContent).toContain('+1')
    await type(numberField(), '415')
    expect(numberField().value).toBe('(415')
    await type(numberField(), '(415555')
    expect(numberField().value).toBe('(415) 555')
    await type(numberField(), '+1 415-555-1234')
    expect(numberField().value).toBe('(415) 555-1234')
    expect(q('[data-phone-complete]')).not.toBeNull()
  })

  it('says when a number can’t be one', async () => {
    await mountToNumber()
    await type(numberField(), '055')
    expect(host.textContent).toContain('Not a valid US or Canadian number.')
    expect(numberField().getAttribute('aria-invalid')).toBe('true')
  })

  it('Send code waits for the whole number and the consent, and sends it as +1', async () => {
    await mountToNumber()
    const send = q<HTMLButtonElement>('[data-phone-send]')!
    await type(numberField(), '415555123')
    expect(send.disabled).toBe(true)
    await type(numberField(), '(415) 555-1234')
    expect(send.disabled).toBe(true)
    await act(async () => q('[data-sms-consent]')!.closest('label')!.querySelector<HTMLButtonElement>('button')!.click())
    expect(send.disabled).toBe(false)
    await act(async () => send.click())
    await until(() => !!q('[data-phone-step="code"]'))
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ phone: '+14155551234', consent: true })
    expect(host.textContent).toContain('+1 (415) 555-1234')
  })
})

describe('the code', () => {
  it('six boxes; a paste fills them and checks it at once; then the phone is linked', async () => {
    await toCodeStep()
    expect(boxes()).toEqual(['', '', '', '', '', ''])
    expect(codeField().getAttribute('autocomplete')).toBe('one-time-code')
    await paste(codeField(), 'Your Dial8 code is 123 456')
    expect(boxes()).toEqual(['1', '2', '3', '4', '5', '6'])
    await flush()
    expect(calls.find((c) => c.url === '/api/account/phone/verify')!.body).toEqual({ code: '123456' })
    await until(() => !!q('[data-phone-code-status]')?.textContent?.includes('Phone linked'))
    await until(() => !!q('[data-phone-step="linked"]'))
    expect(q('[data-phone-step="linked"]')!.textContent).toContain('+1 (415) 555-1234')
    expect(q('[data-start-texting]')!.textContent).toContain('Start texting Joseph')
  })

  it('typed digit by digit, it checks on the sixth', async () => {
    await toCodeStep()
    for (const code of ['1', '12', '123', '1234', '12345']) await type(codeField(), code)
    expect(calls.some((c) => c.url === '/api/account/phone/verify')).toBe(false)
    await type(codeField(), '123456')
    await flush()
    expect(calls.filter((c) => c.url === '/api/account/phone/verify')).toHaveLength(1)
  })

  it('a wrong code says so and empties the boxes for another go', async () => {
    await toCodeStep()
    await type(codeField(), '999999')
    await until(() => !!q('[data-phone-code-status]')?.textContent?.includes("doesn't match"))
    expect(boxes()).toEqual(['', '', '', '', '', ''])
    expect(codeField().getAttribute('aria-invalid')).toBe('true')
    expect(codeField().disabled).toBe(false)
  })

  it('a new code waits 30 s, then goes to the same number', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await toCodeStep()
    const resend = q<HTMLButtonElement>('[data-phone-resend]')!
    expect(resend.disabled).toBe(true)
    expect(resend.textContent).toBe(`Send a new code in ${RESEND_AFTER_S}s`)
    for (let s = 0; s < RESEND_AFTER_S; s++) await act(async () => void vi.advanceTimersByTime(1000))
    expect(resend.disabled).toBe(false)
    expect(resend.textContent).toBe('Send a new code')
    await act(async () => resend.click())
    await until(() => host.textContent!.includes('New code sent.'))
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/account/phone').map((c) => (c.body as { phone: string }).phone)).toEqual(['+14155551234', '+14155551234'])
    expect(resend.disabled).toBe(true)
  })

  it('Change number goes back to the number, as it was', async () => {
    await toCodeStep()
    await act(async () => q<HTMLButtonElement>('[data-phone-change]')!.click())
    expect(q('[data-phone-step="number"]')).not.toBeNull()
    expect(numberField().value).toBe('(415) 555-1234')
  })
})

describe('once linked: start texting', () => {
  beforeEach(() => {
    linked = { number: '+14155551234', masked: '+1 ••• ••• 1234', verifiedAt: '2026-10-24', optedOut: false }
  })

  it('a QR code that opens Messages to the agent with a hello typed in, the number to copy, and a button on a phone', async () => {
    await act(async () => root.render(<PhoneSection compact name="Joseph" />))
    await until(() => !!q('[data-start-texting]'))
    expect(q('[data-start-texting]')!.textContent).toContain('Start texting Joseph')
    // Your own phone: one quiet line under it, with Remove; no alerts switch (the sign-up consent covers them).
    expect(q('[data-phone-step="linked"]')!.textContent).toContain('Your phone +1 (415) 555-1234')
    expect(q('[data-sms-alerts]')).toBeNull()
    expect(q('[data-qr-code]')!.getAttribute('data-qr-code')).toBe('SMSTO:+15550000000:Hey Joseph!')
    expect(q('[data-qr-code] path')!.getAttribute('d')!.length).toBeGreaterThan(100)
    expect(q('[data-agent-number]')!.textContent).toContain('+1 (555) 000-0000')
    expect(q<HTMLAnchorElement>('[data-text-agent]')!.getAttribute('href')).toBe('sms:+15550000000?&body=Hey%20Joseph!')
  })

  it('copies the agent’s number', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await act(async () => root.render(<PhoneSection compact name="Joseph" />))
    await until(() => !!q('[data-agent-number]'))
    await act(async () => q<HTMLButtonElement>('[data-agent-number]')!.click())
    expect(writeText).toHaveBeenCalledWith('+1 (555) 000-0000')
    expect(q('[data-agent-number]')!.getAttribute('aria-label')).toBe('Copied')
  })

  it('a linked phone never asks a second time: texts while away just happen (Liam, 2026-10-31: no setting)', async () => {
    await act(async () => root.render(<PhoneSection compact name="Joseph" />))
    await until(() => !!q('[data-phone-step="linked"]'))
    expect(q('[data-away-consent]')).toBeNull()
    expect(document.body.textContent).not.toMatch(/while you're away/i)
  })

  it('opted out: no QR, how to turn texts back on', async () => {
    linked = { ...linked!, optedOut: true }
    await act(async () => root.render(<PhoneSection compact name="Joseph" />))
    await until(() => !!q('[data-phone-step="linked"]'))
    expect(q('[data-qr-code]')).toBeNull()
    expect(host.textContent).toContain('Text START')
  })
})

describe('its own number (Liam, 2026-11-02)', () => {
  beforeEach(() => {
    canGet = true
  })

  it('first, a button gets the agent a number; then the phone links to it, the number named', async () => {
    await act(async () => root.render(<PhoneSection compact name="Joseph" />))
    await until(() => !!q('[data-phone-step="get-number"]'))
    expect(q('[data-phone-step="get-number"]')!.textContent).toContain('Give Joseph a phone number of its own')
    expect(q('[data-phone-number]')).toBeNull()
    await act(async () => q<HTMLButtonElement>('[data-get-number]')!.click())
    await until(() => !!q('[data-phone-step="number"]'))
    expect(calls.some((c) => c.url === '/api/account/agent-number' && c.method === 'POST')).toBe(true)
    expect(q('[data-own-number]')!.textContent).toBe('+1 (646) 555-0199')
    expect(q('[data-phone-step="number"]')!.textContent).toContain("Joseph's number is +1 (646) 555-0199. Link your phone to text it.")
  })

  it('a refusal shows on the button’s step, and nothing moves on', async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({ phone: null, dial8Number: '+15550000000', agentNumber: null, canGetNumber: true, available: true }))
    fetchMock.mockImplementationOnce(async () => Response.json({ error: 'Dial8 has no numbers to give right now. Try again later.' }, { status: 409 }))
    await act(async () => root.render(<PhoneSection compact name="Joseph" />))
    await until(() => !!q('[data-phone-step="get-number"]'))
    await act(async () => q<HTMLButtonElement>('[data-get-number]')!.click())
    await until(() => !!q('[role="alert"]'))
    expect(q('[role="alert"]')!.textContent).toBe('Dial8 has no numbers to give right now. Try again later.')
    expect(q('[data-phone-step="get-number"]')).not.toBeNull()
  })

  it('none ready yet (202: one is being bought): asks again shortly, then shows it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const routes = fetchMock.getMockImplementation()!
    let asked = 0
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: undefined })
      if (url === '/api/account/agent-number') {
        asked++
        if (asked < 3) return Response.json({ pending: true }, { status: 202 })
        own = '+16465550199'
        return Response.json({ number: own })
      }
      return Response.json({ phone: linked, dial8Number: own ?? '+15550000000', agentNumber: own, canGetNumber: canGet && !own, available: true })
    })
    try {
      await act(async () => root.render(<PhoneSection compact name="Joseph" />))
      await until(() => !!q('[data-phone-step="get-number"]'))
      await act(async () => q<HTMLButtonElement>('[data-get-number]')!.click())
      for (let i = 0; i < 2; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(NUMBER_RETRY_MS)))
      await until(() => !!q('[data-own-number]'))
      expect(asked).toBe(3)
      expect(q('[role="alert"]')).toBeNull()
    } finally {
      fetchMock.mockImplementation(routes)
    }
  })

  it('where this Dial8 has no pool, straight to linking the phone to the Dial8 number', async () => {
    canGet = false
    await mountToNumber()
    expect(q('[data-get-number]')).toBeNull()
    expect(q('[data-phone-step="number"]')!.textContent).toContain("We'll send you a code to link your phone.")
  })

  it('a phone linked to the Dial8 number can give the agent its own, and starts texting that one', async () => {
    linked = { number: '+14155551234', masked: '+1 ••• ••• 1234', verifiedAt: '2026-10-24', optedOut: false }
    await act(async () => root.render(<PhoneSection compact name="Joseph" />))
    await until(() => !!q('[data-start-texting]'))
    expect(q('[data-agent-number]')!.textContent).toContain('+1 (555) 000-0000')
    expect(q('[data-get-number]')!.textContent).toBe('Give Joseph its own number')
    await act(async () => q<HTMLButtonElement>('[data-get-number]')!.click())
    await until(() => q('[data-agent-number]')?.getAttribute('data-agent-number') === '+16465550199')
    expect(q('[data-qr-code]')!.getAttribute('data-qr-code')).toBe('SMSTO:+16465550199:Hey Joseph!')
    expect(q('[data-get-number]')).toBeNull()
  })
})
