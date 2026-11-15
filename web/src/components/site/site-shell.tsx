'use client'

/**
 * The public site's frame, for the homepage and the feature deep dives: a
 * side panel that lists every page (lib/marketing/site-nav.ts) with a search
 * box over it, the page down the middle, and on wide screens a right rail
 * with the signup button and the page's own sections ("On this page").
 *
 * There is no bar across the top on a wide screen: the panel is the
 * navigation. Below `lg` there is a bar across the top instead: from `md` up
 * it carries the site's menus (Features, Switch, Resources, each opening a
 * panel of links under the bar) and both buttons; on a phone it carries a
 * menu button, and the panel opens as a sheet.
 *
 * No fills on the panel or the rail: the public sky
 * (components/sky/public-sky.tsx) shows through them like the rest of the
 * page. Flat cost: one IntersectionObserver for the outline, nothing tied to
 * the scroll position.
 */
import { clsx } from 'clsx'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { usePostHog } from 'posthog-js/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, ChevronDown, Download, Menu, Search, X } from 'lucide-react'
import { Logo } from '@/components/logo'
import { useSignupHref } from '@/components/signup-href'
import { hasDownload } from '@/lib/app-download'
import { MORE_FEATURES, SITE_NAV, TOP_FEATURES, type SiteNavGroup, type SiteNavItem } from '@/lib/marketing/site-nav'

export interface OutlineItem {
  id: string
  label: string
}

/** The groups with only the items whose name contains `query`. */
export function filterNav(groups: SiteNavGroup[], query: string): SiteNavGroup[] {
  const q = query.trim().toLowerCase()
  if (!q) return groups
  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => item.name.toLowerCase().includes(q)) }))
    .filter((group) => group.items.length > 0)
}

function NavLink({ item, active, onNavigate }: { item: SiteNavItem; active: boolean; onNavigate?: () => void }) {
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
        active ? 'bg-foreground/[0.06] font-medium text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground'
      )}
    >
      <Icon aria-hidden className={clsx('h-4 w-4 shrink-0', active ? 'text-foreground' : 'text-muted-foreground/80 group-hover:text-foreground')} />
      <span className="truncate">{item.name}</span>
    </Link>
  )
}

/** The search box and the grouped links: the panel's body, and the sheet's on a phone. */
function SiteNav({ onNavigate, autoFocus = false }: { onNavigate?: () => void; autoFocus?: boolean }) {
  const pathname = usePathname()
  const router = useRouter()
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const groups = useMemo(() => filterNav(SITE_NAV, query), [query])

  // ⌘K / Ctrl+K puts the cursor in the search box.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    // The search box stays put; only the list under it scrolls.
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault()
          const first = groups[0]?.items[0]
          if (!first) return
          setQuery('')
          onNavigate?.()
          router.push(first.href)
        }}
        className="relative shrink-0"
      >
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus={autoFocus}
          aria-label="Search pages"
          placeholder="Search pages"
          autoComplete="off"
          className="h-9 w-full rounded-full border border-border bg-foreground/[0.04] pl-9 pr-10 text-sm text-foreground placeholder:text-muted-foreground focus:border-foreground/30 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        <kbd aria-hidden className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 font-sans text-xs text-muted-foreground/70 lg:block">
          ⌘K
        </kbd>
      </form>

      <nav aria-label="Site" className="mt-5 min-h-0 flex-1 space-y-6 overflow-y-auto pb-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {groups.length === 0 && <p className="px-2.5 text-sm text-muted-foreground">No page by that name.</p>}
        {groups.map((group, i) => (
          <div key={group.label ?? i}>
            {group.label && <p className="mb-1.5 px-2.5 text-xs font-medium text-muted-foreground/70">{group.label}</p>}
            <ul className={clsx('space-y-px', group.label && 'ml-2.5 border-l border-border pl-1.5')}>
              {group.items.map((item) => (
                <li key={item.href}>
                  <NavLink item={item} active={!item.href.includes('#') && pathname === item.href} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  )
}

function SignupButton({ location, className }: { location: string; className?: string }) {
  const posthog = usePostHog()
  const signupHref = useSignupHref()
  return (
    <a
      href={signupHref}
      onClick={() => posthog?.capture('cta_clicked', { location, type: 'sign_up' })}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-full border border-transparent bg-primary font-medium whitespace-nowrap text-primary-foreground shadow-md transition-colors hover:bg-primary/90',
        className
      )}
    >
      Sign up free
      <ArrowRight aria-hidden className="h-4 w-4" />
    </a>
  )
}

function SigninButton({ location, className }: { location: string; className?: string }) {
  const posthog = usePostHog()
  return (
    <a
      href="/login?mode=signin"
      onClick={() => posthog?.capture('cta_clicked', { location, type: 'sign_in' })}
      className={clsx(
        'inline-flex items-center justify-center rounded-full border border-border bg-background/40 font-medium whitespace-nowrap text-foreground transition-colors hover:bg-accent',
        className
      )}
    >
      Sign in
    </a>
  )
}

/** The page's sections, with the one in view marked. */
function Outline({ items }: { items: OutlineItem[] }) {
  const [active, setActive] = useState(items[0]?.id ?? '')

  useEffect(() => {
    if (items.length === 0 || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) setActive(entry.target.id)
      },
      { rootMargin: '-20% 0px -60% 0px', threshold: 0 }
    )
    for (const item of items) {
      const el = document.getElementById(item.id)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [items])

  if (items.length === 0) return null
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-muted-foreground/70">On this page</p>
      <ul className="border-l border-border">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              className={clsx(
                '-ml-px block border-l py-1.5 pl-3.5 text-sm transition-colors',
                active === item.id ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

function DownloadLink() {
  const posthog = usePostHog()
  if (!hasDownload()) return null
  return (
    <a
      href="/api/download"
      onClick={() => posthog?.capture('cta_clicked', { location: 'site_rail', type: 'download_macos' })}
      className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <Download aria-hidden className="h-4 w-4" />
      Download for macOS
    </a>
  )
}

/** The bar's menus: the same pages the panel lists, regrouped for a row across the top. */
const BAR_MENUS: { label: string; groups: SiteNavGroup[] }[] = [
  {
    label: 'Features',
    groups: [
      { label: 'Top features', items: TOP_FEATURES },
      { label: 'More features', items: MORE_FEATURES },
    ],
  },
  { label: 'Switch', groups: SITE_NAV.filter((group) => group.label === 'Switch') },
  {
    label: 'Resources',
    groups: [{ label: 'Resources', items: (SITE_NAV.find((group) => group.label === 'More')?.items ?? []).filter((item) => item.href !== '/pricing') }],
  },
]

const BAR_LINK = 'inline-flex h-9 items-center gap-1 rounded-full px-3 text-sm text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground'

/**
 * The bar's menus and the panel the open one drops. A menu opens under the
 * pointer or on a click (a click is what a keyboard and a touch screen have),
 * and closes when the pointer leaves the bar, on Escape, or when a link in it
 * is followed.
 */
function BarMenus() {
  const [open, setOpen] = useState<string | null>(null)
  const menu = BAR_MENUS.find((entry) => entry.label === open)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <nav aria-label="Site" className="hidden h-full items-center md:flex" onMouseLeave={() => setOpen(null)}>
      {BAR_MENUS.map((entry) => (
        <button
          key={entry.label}
          type="button"
          aria-expanded={open === entry.label}
          onMouseEnter={() => setOpen(entry.label)}
          onClick={() => setOpen((current) => (current === entry.label ? null : entry.label))}
          className={clsx(BAR_LINK, open === entry.label && 'bg-foreground/[0.06] text-foreground')}
        >
          {entry.label}
          <ChevronDown aria-hidden className={clsx('h-3.5 w-3.5 transition-transform duration-200', open === entry.label && 'rotate-180')} />
        </button>
      ))}
      <Link href="/pricing" onMouseEnter={() => setOpen(null)} className={BAR_LINK}>
        Pricing
      </Link>

      {menu && (
        // Full width under the bar, and touching it, so the pointer never crosses a gap on its way down.
        <div className="ni-bar-panel absolute inset-x-0 top-full border-b border-border bg-background px-4 pt-5 pb-6 shadow-2xl">
          <div key={menu.label} className="ni-bar-panel-body mx-auto flex max-w-3xl flex-col gap-6">
            {menu.groups.map((group) => (
              <div key={group.label}>
                {menu.groups.length > 1 && <p className="mb-2 px-2.5 text-xs font-medium text-muted-foreground/70">{group.label}</p>}
                <ul className="grid grid-cols-3 gap-1 lg:grid-cols-4">
                  {group.items.map((item) => {
                    const Icon = item.icon
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          onClick={() => setOpen(null)}
                          className="group flex items-center gap-3 rounded-xl px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-foreground/[0.06]"
                        >
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-foreground/15 bg-background transition-transform duration-200 group-hover:scale-105">
                            <Icon aria-hidden className="h-4 w-4" />
                          </span>
                          <span className="truncate">{item.name}</span>
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
      <style>{`
@media (prefers-reduced-motion: no-preference) {
  .ni-bar-panel { animation: ni-bar-panel 0.22s cubic-bezier(0.05, 0.7, 0.1, 1) both; }
  .ni-bar-panel-body { animation: ni-bar-panel-body 0.28s cubic-bezier(0.05, 0.7, 0.1, 1) both; }
}
@keyframes ni-bar-panel { from { opacity: 0; } to { opacity: 1; } }
@keyframes ni-bar-panel-body { from { opacity: 0; transform: translateY(-0.4rem); } to { opacity: 1; transform: none; } }
`}</style>
    </nav>
  )
}

export function SiteShell({ children, outline = [] }: { children: React.ReactNode; outline?: OutlineItem[] }) {
  // Every link in the sheet closes it on click (onNavigate), including one
  // that leads to a section of this same page and so changes no pathname.
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!menuOpen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [menuOpen])

  return (
    <div className="overflow-x-clip">
      {/* Wide screens: the side panel. */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-border lg:flex">
        <div className="px-5 pt-6 pb-4">
          <Link href="/" title="Home" className="inline-block">
            <Logo className="[&>span]:text-base" />
          </Link>
        </div>
        <div className="flex min-h-0 flex-1 flex-col px-3">
          <SiteNav />
        </div>
        {/* Below `xl` there is no right rail, so the buttons live here. */}
        <div className="flex gap-2 border-t border-border p-3 xl:hidden">
          <SigninButton location="site_panel" className="h-9 flex-1 px-3 text-sm" />
          <SignupButton location="site_panel" className="h-9 flex-1 px-3 text-sm [&>svg]:hidden" />
        </div>
      </aside>

      {/* Widest screens: the right rail. */}
      <aside className="fixed inset-y-0 right-0 z-40 hidden w-56 flex-col gap-8 overflow-y-auto px-5 pt-6 pb-6 xl:flex [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex flex-col gap-2">
          <SignupButton location="site_rail" className="h-10 px-4 text-sm" />
          <SigninButton location="site_rail" className="h-10 px-4 text-sm" />
        </div>
        <Outline items={outline} />
        <DownloadLink />
      </aside>

      {/* Narrow screens: a slim bar, and the panel as a sheet. */}
      <header className="fixed inset-x-0 top-0 z-50 flex h-14 items-center justify-between border-b border-border bg-background/70 px-4 backdrop-blur-xl lg:hidden">
        <div className="flex h-full items-center gap-6">
          <Link href="/" title="Home">
            <Logo className="[&>span]:text-base" />
          </Link>
          <BarMenus />
        </div>
        <div className="flex items-center gap-2">
          <SigninButton location="site_bar" className="hidden h-8 px-3.5 text-sm md:inline-flex" />
          <SignupButton location="site_bar" className="h-8 px-3.5 text-sm [&>svg]:hidden" />
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label={menuOpen ? 'Close menu' : 'Menu'}
            aria-expanded={menuOpen}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-foreground md:hidden"
          >
            {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </header>
      {menuOpen && (
        <div className="fixed inset-x-0 bottom-0 top-14 z-50 flex flex-col bg-background/95 px-4 pt-4 pb-6 backdrop-blur-xl md:hidden">
          <SiteNav onNavigate={() => setMenuOpen(false)} />
          <SigninButton location="site_sheet" className="mt-4 h-10 w-full shrink-0 px-4 text-sm" />
        </div>
      )}

      <div className="pt-14 lg:pl-60 lg:pt-0 xl:pr-56">{children}</div>
    </div>
  )
}
