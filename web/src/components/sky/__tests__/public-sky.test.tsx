// @vitest-environment jsdom
/**
 * PublicSky, mounted once from the root providers: the marketing sky behind
 * public pages, nothing on the app's own routes.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'

const nav = vi.hoisted(() => ({ pathname: '/' }))
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }))

import { PublicSky } from '../public-sky'

describe('PublicSky', () => {
  it('renders the sky layer on a public page', () => {
    nav.pathname = '/pricing'
    expect(renderToString(h(PublicSky))).toContain('data-marketing-sky')
  })

  it('renders nothing in the signed-in app', () => {
    nav.pathname = '/account'
    expect(renderToString(h(PublicSky))).toBe('')
  })
})
