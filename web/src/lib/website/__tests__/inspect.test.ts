/**
 * Reading a business's site repo (roadmap track E, step 2): the framework,
 * the host, the live address and the forms, for the kinds of sites service
 * businesses run. None of these fixtures is any one business's: each is a
 * shape a designer commonly ships.
 */
import { describe, expect, it } from 'vitest'
import { buildStepsOf, detectFramework, detectHost, filesToRead, formCandidate, formFields, formSubmits, inspectFiles, inspectRepo, platformHostOf, siteUrlOf } from '../inspect'

function repo(files: Record<string, string>) {
  return {
    files: Object.entries(files).map(([path, text]) => ({ path, size: text.length })),
    truncated: false,
    read: async (path: string) => files[path] ?? null,
  }
}

const NEXT_QUOTE_FORM = `'use client'
export default function QuotePage() {
  return (
    <form action="https://formspree.io/f/xyzabcd" method="POST">
      <h1>Get a free quote</h1>
      <input name="name" />
      <input type="email" name="email" />
      <input type="tel" name="phone" />
      <textarea name="message" />
      <button>Send</button>
    </form>
  )
}`

describe('detectFramework', () => {
  it('reads package.json dependencies first', () => {
    expect(detectFramework(new Set(['package.json']), { dependencies: { next: '15.0.0', react: '19' } })).toBe('nextjs')
    expect(detectFramework(new Set(['package.json']), { devDependencies: { astro: '5' } })).toBe('astro')
    expect(detectFramework(new Set(['package.json']), { dependencies: { '@remix-run/react': '2' } })).toBe('remix')
    expect(detectFramework(new Set(['package.json']), { devDependencies: { '@11ty/eleventy': '3' } })).toBe('eleventy')
  })

  it('falls back to config files, then plain HTML', () => {
    expect(detectFramework(new Set(['hugo.toml', 'layouts/index.html', 'content/_index.md']), null)).toBe('hugo')
    expect(detectFramework(new Set(['_config.yml', 'Gemfile', 'index.html']), null)).toBe('jekyll')
    expect(detectFramework(new Set(['index.html', 'styles.css']), null)).toBe('html')
    expect(detectFramework(new Set(['README.md']), null)).toBe('unknown')
  })
})

describe('detectHost and siteUrlOf', () => {
  it('names the host from its deploy files', () => {
    expect(detectHost(new Set(['vercel.json']))).toBe('vercel')
    expect(detectHost(new Set(['netlify.toml']))).toBe('netlify')
    expect(detectHost(new Set(['CNAME', 'index.html']))).toBe('github-pages')
    expect(detectHost(new Set(['.github/workflows/deploy-pages.yml']))).toBe('github-pages')
    expect(detectHost(new Set(['wrangler.toml']))).toBe('cloudflare')
    expect(detectHost(new Set(['index.html']))).toBe('unknown')
  })

  it('makes an https origin URL of a domain, never github.com', () => {
    expect(siteUrlOf('www.janescleaning.com\n')).toBe('https://www.janescleaning.com')
    expect(siteUrlOf('https://JanesCleaning.com/about')).toBe('https://janescleaning.com')
    expect(siteUrlOf('https://jane.github.com/site')).toBeNull()
    expect(siteUrlOf('localhost')).toBeNull()
    expect(siteUrlOf(42)).toBeNull()
  })
})

describe('formFields and formSubmits', () => {
  it('reads name attributes, JSX names and form-library registrations', () => {
    expect(formFields(NEXT_QUOTE_FORM)).toEqual(['name', 'email', 'phone', 'message'])
    expect(formFields(`<input {...register('fullName')} /><input name={'zip'} /><meta name="viewport" />`)).toEqual(['zip', 'fullName'])
  })

  it('tells how a form sends, the specific service first', () => {
    expect(formSubmits(NEXT_QUOTE_FORM)).toEqual({ submits: 'formspree', target: 'https://formspree.io/f/xyzabcd' })
    expect(formSubmits('<form name="contact" data-netlify="true">').submits).toBe('netlify-forms')
    expect(formSubmits("import emailjs from '@emailjs/browser'").submits).toBe('emailjs')
    expect(formSubmits('<form action="mailto:jane@example.com">').submits).toBe('mailto')
    expect(formSubmits("await fetch('/api/contact', { method: 'POST' })")).toEqual({ submits: 'api-route', target: '/api/contact' })
    expect(formSubmits("'use server'\nexport async function send() {}").submits).toBe('server-action')
    expect(formSubmits('<form action="https://example.org/submit">').submits).toBe('action-url')
    expect(formSubmits('fetch("https://dial8.ai/api/intake/quotes/qk_' + 'a'.repeat(43) + '")').submits).toBe('dial8')
    expect(formSubmits('<form><input name="q"></form>').submits).toBe('none')
  })
})

describe('formCandidate', () => {
  it('ranks a quote form above a contact form above a generic one', () => {
    const quote = formCandidate('app/quote/page.tsx', NEXT_QUOTE_FORM)!
    const contact = formCandidate('src/pages/contact.astro', '<form><h2>Contact us</h2><input name="name"/><input name="email"/></form>')!
    const other = formCandidate('components/Thing.tsx', '<form onSubmit={go}><input name="x"/></form>')!
    expect(quote.kind).toBe('quote')
    expect(contact.kind).toBe('contact')
    expect(other.kind).toBe('other')
    expect(quote.score).toBeGreaterThan(contact.score)
    expect(contact.score).toBeGreaterThan(other.score)
  })

  it('skips files with no form, and search boxes', () => {
    expect(formCandidate('app/page.tsx', '<main>Hello</main>')).toBeNull()
    expect(formCandidate('components/Search.tsx', '<form><input name="q" /></form>')).toBeNull()
  })

  it('pushes a newsletter sign-up down', () => {
    const newsletter = formCandidate('components/Footer.tsx', '<form><input name="email" /><button>Subscribe</button></form>')!
    const contact = formCandidate('components/Contact.tsx', '<form><h2>Get in touch</h2><input name="name"/><input name="email"/><textarea name="message"/></form>')!
    expect(contact.score).toBeGreaterThan(newsletter.score)
  })
})

describe('filesToRead', () => {
  it('never reads dependencies, build output, tests or bundles, and reads form-ish paths first', () => {
    const picked = filesToRead([
      { path: 'node_modules/x/index.js', size: 10 },
      { path: '.next/server/app.js', size: 10 },
      { path: 'dist/index.html', size: 10 },
      { path: 'src/__tests__/form.test.tsx', size: 10 },
      { path: 'public/app.min.js', size: 10 },
      { path: 'src/components/Footer.tsx', size: 10 },
      { path: 'src/app/get-a-quote/page.tsx', size: 10 },
      { path: 'next.config.js', size: 10 },
    ]).map((f) => f.path)
    expect(picked[0]).toBe('src/app/get-a-quote/page.tsx')
    expect(picked).toContain('src/components/Footer.tsx')
    expect(picked).not.toContain('node_modules/x/index.js')
    expect(picked).not.toContain('.next/server/app.js')
    expect(picked).not.toContain('dist/index.html')
    expect(picked).not.toContain('src/__tests__/form.test.tsx')
    expect(picked).not.toContain('public/app.min.js')
    expect(picked).not.toContain('next.config.js')
  })

  it('stays inside the file budget', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ path: `pages/p${i}.html`, size: 1_000 }))
    expect(filesToRead(many)).toHaveLength(40)
  })
})

describe('inspectFiles', () => {
  it('a Next.js site on Vercel with a Formspree quote form', async () => {
    const found = await inspectFiles(
      repo({
        'package.json': JSON.stringify({ dependencies: { next: '15.1.0', react: '19.0.0' } }),
        'vercel.json': '{}',
        'app/page.tsx': '<main>Welcome</main>',
        'app/quote/page.tsx': NEXT_QUOTE_FORM,
        'components/Newsletter.tsx': '<form><input name="email" /></form>',
      }),
    )
    expect(found.framework).toBe('nextjs')
    expect(found.host).toBe('vercel')
    expect(found.forms[0]).toMatchObject({ path: 'app/quote/page.tsx', kind: 'quote', submits: 'formspree', fields: ['name', 'email', 'phone', 'message'] })
  })

  it('a plain HTML site on GitHub Pages with a Netlify-style contact form and its CNAME address', async () => {
    const found = await inspectFiles(
      repo({
        'index.html': '<html><body><a href="contact.html">Contact</a></body></html>',
        'contact.html': '<form name="contact" method="POST" data-netlify="true"><h2>Contact us</h2><input name="name"><input name="email"><textarea name="message"></textarea></form>',
        CNAME: 'www.bestplumbing.co\n',
      }),
    )
    expect(found.framework).toBe('html')
    expect(found.host).toBe('github-pages')
    expect(found.siteUrl).toBe('https://www.bestplumbing.co')
    expect(found.forms[0]).toMatchObject({ path: 'contact.html', kind: 'contact', submits: 'netlify-forms' })
  })

  it('an Astro booking page posting to its own API route', async () => {
    const found = await inspectFiles(
      repo({
        'package.json': JSON.stringify({ devDependencies: { astro: '5.0.0' } }),
        'src/pages/book.astro': '<form id="f"><h1>Book a walk</h1><input name="name"/><input name="phone"/><input name="preferred_date"/></form><script>document.getElementById("f").onsubmit = (e) => { fetch("/api/book", { method: "POST" }) }</script>',
      }),
    )
    expect(found.framework).toBe('astro')
    expect(found.forms[0]).toMatchObject({ kind: 'booking', submits: 'api-route', target: '/api/book' })
  })

  it('a repo with no form says so', async () => {
    const found = await inspectFiles(repo({ 'index.html': '<h1>Hello</h1>' }))
    expect(found.forms).toEqual([])
  })
})

/** A client component whose inputs live in state: it uploads photos, then posts JSON to its own API route. */
const STATE_QUOTE_FORM = `'use client'
import { useState } from 'react'
export default function OnlineQuote() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [notes, setNotes] = useState('')
  const handleSubmit = async (event) => {
    event.preventDefault()
    const photoUrls = await Promise.all(files.map((f) => fetch(\`/api/photo-upload?filename=\${f.name}\`, { method: 'POST', body: f }).then((r) => r.json())))
    await fetch('/api/quote-submission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, name, phoneNumber: phoneNumber, notes, photoUrls }),
    })
  }
  return (
    <section>
      <h2>Get a Free Estimate</h2>
      <form onSubmit={handleSubmit}>
        <input placeholder="Full Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input type="tel" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} />
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </form>
    </section>
  )
}`

/** A contact page whose own copy, outside the form, says "Schedule your visit". */
const CONTACT_PAGE_WITH_CTA = `export default function Contact() {
  return (
    <main>
      <form onSubmit={handleSubmit}>
        <label htmlFor="name">Name</label><input name="name" id="name" />
        <input name="email" /><input name="phone" /><textarea name="message" />
      </form>
      <p>Schedule your visit today and see the difference.</p>
      <a href="/schedule">Schedule a visit</a>
    </main>
  )
}`

/** A call-back box: an input and a button's handler that POSTs, no <form>. */
const CALL_BACK = `export function CallBack() {
  const send = () => fetch('/api/request-call', { method: 'POST', body: JSON.stringify({ phoneNumber, source: 'call_request' }) })
  return <div><input type="tel" value={phoneNumber} /><button onClick={send}>Call me</button></div>
}`

describe('a Next.js site whose forms are client components posting JSON to their own API routes', () => {
  const files = {
    'package.json': JSON.stringify({ dependencies: { next: '14.2.0' }, scripts: { build: 'npm run db:migrate && next build' } }),
    'src/app/page.tsx': "import OnlineQuote from '@/components/OnlineQuote'\nexport default function Home() { return <OnlineQuote /> }",
    'src/components/OnlineQuote.tsx': STATE_QUOTE_FORM,
    'src/app/contact/page.tsx': CONTACT_PAGE_WITH_CTA,
    'src/components/CallBack.tsx': CALL_BACK,
    'src/app/api/quote-submission/route.ts': "export async function POST(req) { const body = await req.json(); return Response.json({ ok: true }) } // <input",
    'src/lib/migrations/002_add_booking_items.ts': 'export const up = `create table booking_items`',
    'src/services/bookingService.ts': 'export async function createBooking() {}',
  }

  it('finds the quote form first, its fields from the JSON body, and where it posts past the photo upload', async () => {
    const found = await inspectFiles(repo(files))
    expect(found.forms[0]).toMatchObject({
      path: 'src/components/OnlineQuote.tsx',
      kind: 'quote',
      fields: ['email', 'name', 'phoneNumber', 'notes', 'photoUrls'],
      submits: 'api-route',
      target: '/api/quote-submission',
      page: 'src/app/page.tsx',
    })
    expect(found.buildScript).toBe('npm run db:migrate && next build')
  })

  it("a contact form is a contact form, whatever the page's other copy says", async () => {
    const found = await inspectFiles(repo(files))
    expect(found.forms.find((f) => f.path === 'src/app/contact/page.tsx')).toMatchObject({ kind: 'contact', fields: ['name', 'email', 'phone', 'message'] })
  })

  it('inputs a button POSTs count as a form', () => {
    expect(formCandidate('src/components/CallBack.tsx', CALL_BACK)).toMatchObject({ submits: 'api-route', target: '/api/request-call', fields: ['phoneNumber', 'source'] })
    expect(formCandidate('src/components/Card.tsx', '<div><input type="checkbox" /></div>')).toBeNull()
  })

  it('never reads API routes or migrations, and reads services after every page and component', () => {
    const paths = filesToRead(Object.entries(files).map(([path, t]) => ({ path, size: t.length }))).map((f) => f.path)
    expect(paths).not.toContain('src/app/api/quote-submission/route.ts')
    expect(paths).not.toContain('src/lib/migrations/002_add_booking_items.ts')
    expect(paths[paths.length - 1]).toBe('src/services/bookingService.ts')
  })

  it('an upload endpoint is never the target, and a create beats an update', () => {
    expect(formSubmits("fetch('/api/upload-image', {}); fetch('/api/leads', {})").target).toBe('/api/leads')
    expect(formSubmits("fetch('/api/bookings/update'); fetch('/api/bookings/create')").target).toBe('/api/bookings/create')
    expect(formSubmits("fetch('/api/image-upload')").target).toBe('/api/image-upload')
  })
})

describe('the review’s fixes to reading forms', () => {
  it('a JSON body with a nested object keeps its own keys, never the nested ones; other JSON and headers are not fields', () => {
    const text = "fetch('/api/bookings/create', { method: 'POST', body: JSON.stringify({ name, phone, address: { street, city }, date }) }); localStorage.setItem('t', JSON.stringify({ theme })); headers.append('Content-Type', 'x'); formData.append('photo', f)"
    expect(formFields(text)).toEqual(['photo', 'name', 'phone', 'address', 'date'])
  })

  it('an upload or a submit is told by a word of the path, not a piece of one', () => {
    expect(formSubmits("fetch('/api/profile'); fetch('/api/facebook-capi')").target).toBe('/api/profile')
    expect(formSubmits("fetch('/api/facebook-capi'); fetch('/api/book-visit')").target).toBe('/api/book-visit')
  })

  it("the business's back office never outranks a customer's form", () => {
    const admin = formCandidate('src/app/admin/quotes/page.tsx', "<input name=\"name\" /><input name=\"email\" /><input name=\"phone\" /><button onClick={() => fetch('/api/quotes', { method: 'POST' })}>Save quote</button>")
    const customer = formCandidate('src/components/QuoteForm.tsx', "<form onSubmit={send}><input value={x} /></form>; fetch('/api/quote', { method: 'POST' })")
    expect(admin!.score).toBeLessThan(customer!.score)
  })

  it('components and pages are read in any folder; only script files and the back office wait', () => {
    const pages = Array.from({ length: 45 }, (_, i) => ({ path: `src/routes/area-${i}/+page.svelte`, size: 100 }))
    const picked = filesToRead([
      ...pages,
      { path: 'src/lib/components/QuoteForm.svelte', size: 100 },
      { path: 'app/services/[slug]/page.tsx', size: 100 },
      { path: 'src/lib/quoteStore.ts', size: 100 },
      { path: 'app/admin/quotes/page.tsx', size: 100 },
    ]).map((f) => f.path)
    expect(picked).toContain('src/lib/components/QuoteForm.svelte')
    expect(picked).toContain('app/services/[slug]/page.tsx')
    expect(picked).not.toContain('src/lib/quoteStore.ts')
    expect(picked).not.toContain('app/admin/quotes/page.tsx')
  })

  it('what npm run build runs: its pre and post scripts and the scripts it calls', () => {
    expect(buildStepsOf({ prebuild: 'prisma migrate deploy', build: 'next build' })).toBe('prisma migrate deploy && next build')
    expect(buildStepsOf({ build: 'npm run setup && next build', setup: 'pnpm db:push', 'db:push': 'drizzle-kit push', postbuild: 'next-sitemap' })).toBe('npm run setup && next build && pnpm db:push && drizzle-kit push && next-sitemap')
    expect(buildStepsOf({ build: 'npm run build' })).toBe('npm run build')
    expect(buildStepsOf({ dev: 'next dev' })).toBeNull()
  })
})

describe('the host when the repo has no deploy file', () => {
  it("names a host's own address", () => {
    expect(platformHostOf('https://janes-cleaning.vercel.app')).toBe('vercel')
    expect(platformHostOf('https://janes.netlify.app')).toBe('netlify')
    expect(platformHostOf('https://janes.pages.dev')).toBe('cloudflare')
    expect(platformHostOf('https://jane.github.io/site')).toBe('github-pages')
    expect(platformHostOf('https://janes.onrender.com')).toBe('unknown')
    expect(platformHostOf('https://janescleaning.com')).toBeNull()
    expect(platformHostOf('https://vercel.app.evil.com')).toBeNull()
  })

  function github(deployments: unknown[]) {
    const tree = { tree: [{ path: 'package.json', type: 'blob', size: 30 }] }
    const pkg = JSON.stringify({ dependencies: { next: '15.0.0' } })
    return (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/git/trees/')) return Response.json(tree)
      if (url.includes('/contents/package.json')) return Response.json({ encoding: 'base64', content: Buffer.from(pkg).toString('base64'), size: pkg.length })
      if (url.includes('/deployments?per_page=10')) return Response.json(deployments)
      return Response.json({ message: 'Not Found' }, { status: 404 })
    }) as typeof fetch
  }

  it("reads who makes the repo's GitHub deployments, then the homepage's address", async () => {
    const vercel = await inspectRepo({ token: 't', fetchImpl: github([{ id: 1, creator: { login: 'vercel[bot]', type: 'Bot' } }]) }, 'jane/site', 'main')
    expect(vercel.ok && vercel.inspection.host).toBe('vercel')
    const byHomepage = await inspectRepo({ token: 't', fetchImpl: github([]) }, 'jane/site', 'main', { homepage: 'https://janes.netlify.app' })
    expect(byHomepage.ok && byHomepage.inspection.host).toBe('netlify')
    // A deployment made by a person or a workflow names no host.
    const none = await inspectRepo({ token: 't', fetchImpl: github([{ id: 1, creator: { login: 'github-actions[bot]', type: 'Bot' } }]) }, 'jane/site', 'main')
    expect(none.ok && none.inspection.host).toBe('unknown')
  })
})
