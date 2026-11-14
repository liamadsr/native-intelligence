'use client'

import { useState, useRef, useEffect } from 'react'
import { usePostHog } from 'posthog-js/react'
import { Link } from './link'
import { Logo } from './logo'
import { useSignupHref } from './signup-href'

// Anchors into the landing page at `/` (src/app/workspace-page.tsx). These
// hrefs are a contract with that page's section ids — it says so in its
// header. Earlier landing pages used other ids (#features, #team on the sales
// page; #live-agents, #project-management on the classic one), which became
// no-op jumps to the top of the page once those pages were retired.
//
// Names and descriptions describe what each section ACTUALLY shows, so the
// dropdown never promises a section the visitor won't recognize on arrival.
export const FEATURES = [
  { name: 'One Workspace', description: 'Mail, chat, meetings, docs, tasks and customers', href: '/#workspace' },
  { name: 'Shared Memory', description: 'Everything your team says, remembered with its source', href: '/#memory' },
  { name: 'Agents', description: 'Tasks, follow-ups and code, done for you', href: '/#agents' },
  { name: 'Desktop App', description: 'Capture every call — no bot joins the meeting', href: '/#desktop' },
  { name: 'Integrations', description: 'Gmail, Outlook, Slack, your CRM, and MCP', href: '/#integrations' },
]

function NavDropdown({ label, items }: {
  label: string
  items: { name: string; description: string; href: string }[]
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-full px-3 py-1.5 text-sm font-medium text-foreground/80 transition-colors hover:text-foreground hover:bg-foreground/5"
      >
        {label}
        <svg className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-1/2 -translate-x-1/2 top-full mt-2 w-72 rounded-xl border border-border bg-background/95 backdrop-blur-xl shadow-lg p-2 z-50">
          {items.map((item) => (
            <a
              key={item.name}
              href={item.href}
              onClick={() => setOpen(false)}
              className="flex flex-col gap-0.5 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent"
            >
              <span className="text-sm font-medium text-foreground">{item.name}</span>
              <span className="text-xs text-muted-foreground">{item.description}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

function DesktopLinks() {
  return (
    <nav className="hidden sm:flex items-center gap-1">
      <NavDropdown label="Features" items={FEATURES} />
      <Link href="/pricing" className="rounded-full px-3 py-1.5 text-sm font-medium text-foreground/80 transition-colors hover:text-foreground hover:bg-foreground/5">
        Pricing
      </Link>
      <Link href="/blog" className="rounded-full px-3 py-1.5 text-sm font-medium text-foreground/80 transition-colors hover:text-foreground hover:bg-foreground/5">
        Blog
      </Link>
      <Link href="/docs" className="rounded-full px-3 py-1.5 text-sm font-medium text-foreground/80 transition-colors hover:text-foreground hover:bg-foreground/5">
        Docs
      </Link>
      <Link href="/roadmap" className="rounded-full px-3 py-1.5 text-sm font-medium text-foreground/80 transition-colors hover:text-foreground hover:bg-foreground/5">
        Roadmap
      </Link>
    </nav>
  )
}

function DesktopActions() {
  const posthog = usePostHog()
  const signupHref = useSignupHref()

  return (
    <div className="hidden sm:flex items-center gap-2">
      {/* Divider sets the auth actions apart from the nav links so "Sign in"
          doesn't read as just another link like Blog/Docs. */}
      <span className="mr-1 h-5 w-px bg-foreground/15" aria-hidden />
      <a
        href="/login?mode=signin"
        onClick={() => {
          posthog?.capture('cta_clicked', { location: 'navbar', type: 'sign_in' })
        }}
        className="inline-flex items-center justify-center px-4 py-[calc(--spacing(2)-1px)] rounded-full border border-border bg-background/40 whitespace-nowrap text-base font-medium text-foreground transition-colors hover:bg-accent"
      >
        Sign in
      </a>
      <a
        href={signupHref}
        onClick={() => {
          posthog?.capture('cta_clicked', { location: 'navbar', type: 'sign_up' })
        }}
        className="inline-flex items-center justify-center px-4 py-[calc(--spacing(2)-1px)] rounded-full border border-transparent bg-primary shadow-md whitespace-nowrap text-base font-medium text-primary-foreground hover:bg-primary/90"
      >
        Sign up free
      </a>
    </div>
  )
}

function MobileMenu() {
  const [open, setOpen] = useState(false)
  const posthog = usePostHog()
  const signupHref = useSignupHref()

  return (
    <div className="sm:hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex h-9 w-9 items-center justify-center rounded-lg text-foreground"
        aria-label="Menu"
      >
        {open ? (
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        )}
      </button>

      {open && (
        <div className="absolute left-4 right-4 top-full mt-2 rounded-2xl border border-border bg-background/95 backdrop-blur-xl shadow-lg p-4 z-50">
          {/* Features */}
          <div className="space-y-1">
            <p className="px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Features</p>
            {FEATURES.map((feature) => (
              <a
                key={feature.name}
                href={feature.href}
                onClick={() => setOpen(false)}
                className="flex flex-col gap-0.5 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent"
              >
                <span className="text-sm font-medium text-foreground">{feature.name}</span>
                <span className="text-xs text-muted-foreground">{feature.description}</span>
              </a>
            ))}
          </div>

          <div className="my-3 h-px bg-border" />

          {/* Links */}
          <div className="space-y-1">
            <Link href="/pricing" onClick={() => setOpen(false)} className="block rounded-lg px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent">
              Pricing
            </Link>
            <Link href="/blog" onClick={() => setOpen(false)} className="block rounded-lg px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent">
              Blog
            </Link>
            <Link href="/docs" onClick={() => setOpen(false)} className="block rounded-lg px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent">
              Docs
            </Link>
            <Link href="/roadmap" onClick={() => setOpen(false)} className="block rounded-lg px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent">
              Roadmap
            </Link>
          </div>

          <div className="my-3 h-px bg-border" />

          {/* CTAs */}
          <a
            href={signupHref}
            onClick={() => {
              setOpen(false)
              posthog?.capture('cta_clicked', { location: 'navbar', type: 'sign_up' })
            }}
            className="block w-full text-center rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-md hover:bg-primary/90 transition-colors"
          >
            Sign up free
          </a>
          <a
            href="/login?mode=signin"
            onClick={() => {
              setOpen(false)
              posthog?.capture('cta_clicked', { location: 'navbar', type: 'sign_in' })
            }}
            className="mt-2 block w-full text-center rounded-full border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-accent transition-colors"
          >
            Sign in
          </a>
        </div>
      )}
    </div>
  )
}

/** `brandName`: the name to show in place of the logo (only /sms passes it; see Logo). */
export function Navbar({ banner, brandName }: { banner?: React.ReactNode; brandName?: string }) {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 px-6 py-4 lg:left-60">
      <div className="mx-auto max-w-4xl">
        <div className="relative flex items-center justify-between rounded-2xl bg-black/5 backdrop-blur-xl border border-white/20 px-6 py-3 transform-gpu dark:bg-white/5 dark:backdrop-blur-xl dark:border-white/20">
          {/* Left group: logo + nav links, grouped together on the left so they
              read as one cluster, clearly separate from the auth actions. */}
          <div className="flex items-center gap-6">
            <Link href="/" title="Home">
              <Logo className="h-9" name={brandName} />
            </Link>
            {banner && (
              <div className="hidden items-center lg:flex">
                {banner}
              </div>
            )}
            <DesktopLinks />
          </div>

          {/* Right: auth actions + mobile menu */}
          <div className="flex items-center gap-3">
            <DesktopActions />
            <MobileMenu />
          </div>
        </div>
      </div>
    </header>
  )
}
