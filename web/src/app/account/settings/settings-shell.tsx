'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Bug, CreditCard, Mic, Link2, Building2, User, UserCircle, Tag, Mail, Terminal, Cpu, MessageSquare, MessageSquareText, Server, AudioWaveform, Sparkles, Lightbulb, SpellCheck, Keyboard, SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { navRowClass, navSectionLabelClass } from '@/lib/nav-styles'
import { useIsDesktop } from '@/components/desktop-titlebar'
import { MACOS_TRAFFIC_LIGHT_WIDTH } from '@/lib/platform'

const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 320
const SIDEBAR_DEFAULT = 190
const SIDEBAR_COOKIE = 'sidebar_width'

function useSidebarCookieWidth() {
  const [width, setWidth] = useState(SIDEBAR_DEFAULT)
  useEffect(() => {
    const match = document.cookie.match(
      new RegExp(`(?:^|; )${SIDEBAR_COOKIE}=([^;]*)`),
    )
    if (match) {
      const v = parseInt(match[1], 10)
      if (v === 0) {
        setWidth(SIDEBAR_DEFAULT)
      } else if (v >= SIDEBAR_MIN && v <= SIDEBAR_MAX) {
        setWidth(v)
      }
    }
  }, [])
  return width
}

interface NavItem {
  href: string
  label: string
  icon: typeof Mic
  /** Only in the desktop app (a desktop-only feature). */
  desktopOnly?: boolean
}

interface NavSection {
  title: string
  items: NavItem[]
}

const navSections: NavSection[] = [
  {
    title: 'Account',
    items: [
      { href: '/account/settings/profile', label: 'Profile', icon: UserCircle },
      { href: '/account/settings', label: 'Preferences', icon: User },
      { href: '/account/settings/feedback', label: 'Feedback', icon: MessageSquare },
    ],
  },
  {
    title: 'Features',
    items: [
      // Integrations and outbound MCP servers, one list (Claude's Connectors).
      { href: '/account/settings/connectors', label: 'Connectors', icon: Link2 },
      // Native Intelligence as an MCP server, for Claude Code / Cursor.
      { href: '/account/settings/mcp', label: 'NI MCP', icon: Terminal },
      { href: '/account/settings/environments', label: 'Environments', icon: Server },
      { href: '/account/settings/autonomy', label: 'Autonomy', icon: Sparkles },
      { href: '/account/settings/memory', label: 'Memory', icon: Lightbulb },
      { href: '/account/settings/vocabulary', label: 'Vocabulary', icon: SpellCheck },
      { href: '/account/settings/labels', label: 'Labels', icon: Tag },
      { href: '/account/settings/custom-fields', label: 'Custom fields', icon: SlidersHorizontal },
      { href: '/account/settings/email-crm', label: 'Email & CRM', icon: Mail },
    ],
  },
  {
    title: 'Device',
    items: [
      { href: '/account/settings/recording', label: 'Audio', icon: Mic },
      { href: '/account/settings/voice', label: 'Voice', icon: AudioWaveform },
      { href: '/account/settings/dictation', label: 'Dictation', icon: Keyboard },
      { href: '/account/settings/devices', label: 'Devices', icon: Cpu },
      { href: '/account/settings/phone', label: 'Phone', icon: MessageSquareText },
    ],
  },
  {
    title: 'Administration',
    items: [
      { href: '/account/settings/workspace', label: 'Workspace', icon: Building2 },
      { href: '/account/settings/billing', label: 'Billing', icon: CreditCard },
    ],
  },
]

function useIsLocalhost() {
  const [local, setLocal] = useState(false)
  useEffect(() => {
    const h = window.location.hostname
    setLocal(h === 'localhost' || h === '127.0.0.1')
  }, [])
  return local
}

/** Context for settings views to detect overlay mode and navigate within the overlay */
const SettingsShellContext = createContext<{
  isOverlay: boolean
  closeOverlay: () => void
  onNavigate: ((href: string) => void) | null
} | null>(null)

/** Hook for settings views that need to navigate to deep sub-pages.
 *  In overlay mode, navigates within the overlay (no route change).
 *  In standalone mode, uses router.push as normal. */
export function useSettingsNavigate() {
  const ctx = useContext(SettingsShellContext)
  const router = useRouter()

  return useCallback((href: string) => {
    if (ctx?.isOverlay && ctx.onNavigate) {
      ctx.onNavigate(href)
    } else {
      router.push(href)
    }
  }, [ctx, router])
}

/** Close the settings overlay from within a settings view. No-op in standalone
 *  (full-page) mode, where there's no overlay to close. */
export function useSettingsClose() {
  const ctx = useContext(SettingsShellContext)
  return useCallback(() => {
    ctx?.closeOverlay()
  }, [ctx])
}

export function SettingsShell({
  children,
  isOverlay,
  activeSubPath,
  onNavigate,
  onClose,
}: {
  children: React.ReactNode
  /** When true, rendered inside a Dialog overlay — no title bar or page chrome */
  isOverlay?: boolean
  /** Active sub-path for overlay mode (e.g. "recording", "") */
  activeSubPath?: string
  /** Navigation callback for overlay mode — replaces Link */
  onNavigate?: (href: string) => void
  /** Close callback for overlay mode */
  onClose?: () => void
}) {
  const pathname = usePathname()
  const isDesktop = useIsDesktop()
  const sidebarWidth = useSidebarCookieWidth()
  const isLocal = useIsLocalhost()

  const sections = isLocal
    ? [
        ...navSections,
        {
          title: 'Developer',
          items: [
            { href: '/account/settings/developer', label: 'Dev Tools', icon: Bug },
          ],
        },
      ]
    : navSections

  // Determine active state: overlay uses activeSubPath, standalone uses pathname
  const getIsActive = (href: string) => {
    if (isOverlay) {
      const itemSubPath = href.replace(/^\/account\/settings\/?/, '')
      const active = activeSubPath || ''
      // A page under an item (a connector's own page) keeps the item lit; Preferences ('') only matches itself.
      return itemSubPath === active || (itemSubPath !== '' && active.startsWith(`${itemSubPath}/`))
    }
    return href === '/account/settings'
      ? pathname === '/account/settings'
      : pathname.startsWith(href)
  }

  const handleNavClick = (href: string, e: React.MouseEvent) => {
    if (onNavigate) {
      e.preventDefault()
      onNavigate(href)
    }
  }

  const outerClass = isOverlay
    ? 'relative flex h-full flex-col overflow-hidden bg-sidebar'
    : 'relative flex h-dvh flex-col overflow-hidden bg-sidebar'

  const shellContext = useMemo(() => ({
    isOverlay: !!isOverlay,
    closeOverlay: onClose || (() => {}),
    onNavigate: onNavigate || null,
  }), [isOverlay, onClose, onNavigate])

  return (
    <SettingsShellContext.Provider value={shellContext}>
    <div className={outerClass}>
      {/* Title bar spacer — in both modes this clears the macOS traffic lights
          and acts as a window drag region (matching the main tab bar). */}
      {isOverlay ? (
        <div data-tauri-drag-region className="h-11 shrink-0" />
      ) : (
        <>
          <div
            data-tauri-drag-region
            className="flex h-11 shrink-0 items-center bg-sidebar -mt-0.5"
          />
        </>
      )}

      {/* Below title bar: nav sidebar + content */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Settings navigation sidebar */}
        <div
          style={{ width: isOverlay ? SIDEBAR_DEFAULT : sidebarWidth }}
          className="flex shrink-0 flex-col bg-sidebar px-3 pb-3"
        >
          {isOverlay ? (
            <button
              onClick={onClose}
              className="mt-3 mb-3 inline-flex self-start items-center gap-1.5 rounded-full border border-foreground/10 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft className="h-3 w-3" />
              <span>Back to app</span>
              <kbd className="ml-0.5 inline-flex h-[18px] items-center justify-center rounded-[4px] border bg-muted/60 px-1 text-[10px] font-medium text-muted-foreground">Esc</kbd>
            </button>
          ) : (
            <Link
              href="/account"
              className="mb-3 inline-flex self-start items-center gap-1.5 rounded-full border border-foreground/10 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft className="h-3 w-3" />
              <span>Back to app</span>
            </Link>
          )}
          <nav className="scrollbar-hide flex flex-1 flex-col gap-5 overflow-y-auto">
            {sections.map((section) => (
              <div key={section.title}>
                <div className={navSectionLabelClass}>
                  {section.title}
                </div>
                <div className="flex flex-col gap-1">
                  {section.items.filter((item) => isDesktop || !item.desktopOnly).map((item) => {
                    const isActive = getIsActive(item.href)
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={(e) => handleNavClick(item.href, e)}
                        className={navRowClass(isActive)}
                      >
                        <item.icon className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 truncate">{item.label}</span>
                      </Link>
                    )
                  })}
                </div>
              </div>
            ))}
            <div className="flex-1" />
          </nav>
        </div>

        {/* Content area */}
        <div className={cn(
          'min-h-0 flex-1 overflow-hidden rounded-lg bg-background',
          !isOverlay && 'mb-2 mr-2',
        )}>
          {children}
        </div>
      </div>
    </div>
    </SettingsShellContext.Provider>
  )
}
