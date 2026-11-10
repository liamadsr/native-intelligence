// @vitest-environment jsdom
/**
 * The /sms page is the page carriers review for the 10DLC campaign, which is
 * registered under the name Dial8. Until that campaign names the new brand,
 * nothing a person can read on the page may say Native Intelligence: not the
 * body, and not the shared header, sidebar and footer around it.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ usePathname: () => '/sms', useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), useSearchParams: () => new URLSearchParams() }))

import SmsProgram from '../client'
import { metadata } from '../page'

describe('the /sms page', () => {
  it('says Dial8 everywhere, header and footer included', () => {
    const html = renderToStaticMarkup(<SmsProgram />)
    expect(html).toContain('Dial8')
    expect(html).not.toMatch(/Native Intelligence/i)
    // The new mark and app icon are the letters NI: not on this page either.
    expect(html).not.toMatch(/ni-mark|ni-app-icon/)
  })

  it('keeps Dial8 in its title and social metadata', () => {
    const text = JSON.stringify(metadata)
    expect(text).toContain('Dial8')
    expect(text).not.toMatch(/Native Intelligence/i)
  })
})
