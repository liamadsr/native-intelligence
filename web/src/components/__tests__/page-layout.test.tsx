/**
 * One frame for the whole public site: PageLayout draws the shared site shell
 * (components/site/site-shell.tsx) on every page, and keeps its own older
 * frame only for /sms, which shows the held name and no Native Intelligence
 * mark. And no page but /sms draws the retired floating navbar.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/pricing',
}))
vi.mock('posthog-js/react', () => ({ usePostHog: () => undefined }))

import { PageLayout } from '../page-layout'

const sections = [
  { id: 'intro', label: 'Introduction' },
  { id: 'elsewhere', label: 'Another page', href: '/blog' },
]

describe('PageLayout', () => {
  it('draws the shared site shell, with the page\'s own sections as its outline', () => {
    const html = renderToStaticMarkup(createElement(PageLayout, { sections, children: createElement('main', null, 'Body') }))
    expect(html).toContain('aria-label="Search pages"')
    expect(html).toContain('href="/features/mail"')
    expect(html).toContain('On this page')
    expect(html).toContain('href="#intro"')
    // A section that links to another page is the panel's business, not the outline's.
    expect(html).not.toContain('href="#elsewhere"')
    expect(html).not.toContain('data-held-brand')
  })

  it('keeps the older frame, without the shell or the mark, for the held name', () => {
    const html = renderToStaticMarkup(createElement(PageLayout, { sections, brandName: 'Held', children: createElement('main', null, 'Body') }))
    expect(html).toContain('data-held-brand')
    expect(html).not.toContain('aria-label="Search pages"')
    expect(html).not.toContain('ni-mark')
    expect(html).not.toContain('ni-app-icon')
  })
})

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

describe('the retired floating navbar', () => {
  it('is drawn by /sms and no other page', () => {
    const users = sourceFiles(join(process.cwd(), 'src/app'))
      .filter((file) => /from ['"]@\/components\/navbar['"]/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(file.indexOf('src/app')))
    expect(users).toEqual(['src/app/sms/client.tsx'])
  })
})
