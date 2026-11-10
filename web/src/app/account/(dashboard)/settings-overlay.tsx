'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { usePathname, useRouter } from 'next/navigation'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { toast } from 'sonner'
import { SettingsShell } from '../settings/settings-shell'
import { onOAuthCallback, onSoftNavigate } from '@/lib/navigation-events'
import { getIntegration } from '@/lib/integrations/catalog'
import { consumeOAuthReturnClaim } from '@/lib/integrations/oauth-return-claim'

// ── Context ────────────────────────────────────────────────────────

interface SettingsOverlayContextValue {
  /** Open settings overlay, optionally to a specific sub-path (e.g. "recording") */
  openSettings: (subPath?: string) => void
  closeSettings: () => void
  isOpen: boolean
  /** The sub-path currently shown in the overlay (e.g. "teams/abc"). */
  subPath: string
}

const SettingsOverlayContext = createContext<SettingsOverlayContextValue | null>(null)

export function useSettingsOverlay() {
  const ctx = useContext(SettingsOverlayContext)
  if (!ctx) throw new Error('useSettingsOverlay must be used within SettingsOverlayProvider')
  return ctx
}

/** Optional version for components that may or may not be inside the provider */
export function useOptionalSettingsOverlay() {
  return useContext(SettingsOverlayContext)
}

// ── Settings page registry ─────────────────────────────────────────
// Lazy-load settings views so they don't bloat the dashboard bundle.

import { lazy, Suspense } from 'react'

/** Wrapper that adds the standard settings page chrome (header + centered max-width) */
function SettingsPageWrapper({
  title,
  description,
  maxWidth = 'max-w-2xl',
  children,
}: {
  title: string
  description: string
  maxWidth?: string
  children: React.ReactNode
}) {
  return (
    <div className={`mx-auto ${maxWidth} px-8 py-8`}>
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      <div className="mt-8">{children}</div>
    </div>
  )
}

// ── Static settings views ──────────────────────────────────────────

const settingsViews: Record<string, React.LazyExoticComponent<React.ComponentType>> = {
  '': lazy(() => import('../settings/preferences-view').then(m => ({
    default: () => (
      <SettingsPageWrapper title="Preferences" description="Manage your account preferences and settings.">
        <m.PreferencesView />
      </SettingsPageWrapper>
    ),
  }))),
  'profile': lazy(() => import('../settings/profile/profile-view').then(m => ({
    default: () => (
      <SettingsPageWrapper title="Profile" description="Manage your personal profile and workspace access.">
        <m.ProfileView />
      </SettingsPageWrapper>
    ),
  }))),
  'recording': lazy(() => import('../settings/recording/recording-settings-view').then(m => ({ default: m.RecordingSettingsView }))),
  'voice': lazy(() => import('../settings/voice/voice-settings-view').then(m => ({ default: m.VoiceSettingsView }))),
  'autonomy': lazy(() => import('../settings/autonomy/autonomy-settings-view').then(m => ({ default: m.AutonomySettingsView }))),
  'memory': lazy(() => import('../settings/memory/memory-settings-view').then(m => ({ default: m.MemorySettingsView }))),
  'connectors': lazy(() => import('../settings/connectors/connectors-view').then(m => ({ default: m.ConnectorsView }))),
  'connectors/slack': lazy(() => import('../settings/connectors/slack-connector-view').then(m => ({ default: m.SlackConnectorView }))),
  'workspace': lazy(() => import('../settings/workspace/workspace-settings-view').then(m => ({ default: m.WorkspaceSettingsView }))),
  'billing': lazy(() => import('../settings/billing/billing-view').then(m => ({
    default: () => (
      <SettingsPageWrapper title="Billing" description="Manage your subscription and view usage." maxWidth="max-w-4xl">
        <m.BillingView />
      </SettingsPageWrapper>
    ),
  }))),
  'feedback': lazy(() => import('../settings/feedback/feedback-settings-view').then(m => ({ default: m.FeedbackSettingsView }))),
  'labels': lazy(() => import('../settings/labels/labels-settings-view').then(m => ({ default: m.LabelsSettingsView }))),
  'custom-fields': lazy(() => import('../settings/custom-fields/custom-fields-settings-view').then(m => ({ default: m.CustomFieldsSettingsView }))),
  'vocabulary': lazy(() => import('../settings/vocabulary/vocabulary-settings-view').then(m => ({ default: m.VocabularySettingsView }))),
  'dictation': lazy(() => import('../settings/dictation/dictation-settings-view').then(m => ({ default: m.DictationSettingsView }))),
  'email-crm': lazy(() => import('../settings/email-crm/page')),
  'mcp': lazy(() => import('../settings/mcp/mcp-settings-view').then(m => ({ default: m.McpSettingsView }))),
  'devices': lazy(() => import('../settings/devices/devices-settings-view').then(m => ({ default: m.DevicesSettingsView }))),
  'phone': lazy(() => import('../settings/phone/phone-settings-view').then(m => ({ default: m.PhoneSettingsView }))),
  // Teams moved to the primary-nav "Teams" view (views/teams-view.tsx); no
  // longer a settings page.
  'environments': lazy(() => import('../settings/environments/environments-view').then(m => ({ default: m.EnvironmentsView }))),
}

// Dev Tools — registered ONLY in development so the overlay resolves it (instead
// of silently falling back to Preferences). Adding it conditionally on
// `process.env.NODE_ENV`, which the build inlines, lets webpack dead-code-
// eliminate the import from production bundles entirely — the view can never be
// loaded or rendered in prod, even via a direct openSettings('developer') call.
if (process.env.NODE_ENV !== 'production') {
  settingsViews['developer'] = lazy(() =>
    import('../settings/developer/dev-settings-view').then((m) => ({
      default: () => (
        <SettingsPageWrapper title="Developer" description="Tools for local development and testing. Not available in production.">
          <m.DevSettingsView />
        </SettingsPageWrapper>
      ),
    })),
  )
}

// ── Dynamic settings views (connector details) ─────────────────────

// Integration name/description come from the shared catalog. This map used to
// be hand-maintained here, and an omission was SILENT — resolveView() returned
// null and the overlay fell back to Preferences, so the integration looked
// missing when opened from the dashboard. HubSpot, Asana and Jira each shipped
// that bug. `__tests__/overlay-resolves-catalog.test.tsx` derives its cases
// from INTEGRATION_CATALOG so the omission can't come back silently.
//
// Only the plain-data half is imported: the icons module is client-side React
// and the detail view (which owns the icons) is deliberately kept behind the
// lazy import below so the overlay bundle stays thin.
const LazyIntegrationDetail = lazy(() =>
  import('../settings/integrations/[provider]/[capability]/integration-detail-view').then(m => ({ default: m.IntegrationDetailView }))
)
const LazyLocalExchangeDetail = lazy(() =>
  import('../settings/integrations/local-exchange/calendar/local-exchange-detail-view').then(m => ({ default: m.LocalExchangeDetailView }))
)
const LazyMcpConnector = lazy(() =>
  import('../settings/connectors/mcp-connector-view').then(m => ({ default: m.McpConnectorView }))
)

/**
 * The sub-path a settings link means today. Integrations became Connectors
 * (2026-10-22): `integrations` and `integrations/{…}` (old links, a desktop
 * soft navigation, a stored deep link) land on `connectors` and
 * `connectors/{…}`, so nothing that still says integrations falls through
 * to Preferences.
 */
export function normalizeSettingsSubPath(subPath: string): string {
  return subPath
    .replace(/^integrations(?=\/|$)/, 'connectors')
    // Read anywhere moved into Voice (2026-10-22), like its page's redirect.
    .replace(/^read-anywhere$/, 'voice')
}

/**
 * Resolve a sub-path to a component. Returns null if unknown.
 *
 * Exported for `__tests__/overlay-resolves-catalog.test.tsx`, which asserts
 * every catalog pair resolves here rather than falling through to Preferences.
 */
export function resolveView(rawSubPath: string): React.ReactNode | null {
  const subPath = normalizeSettingsSubPath(rawSubPath)
  // Static match
  const StaticView = settingsViews[subPath]
  if (StaticView) return <StaticView />

  // A connected MCP server: connectors/mcp/{serverId}
  const mcpMatch = subPath.match(/^connectors\/mcp\/([^/]+)$/)
  if (mcpMatch) return <LazyMcpConnector key={mcpMatch[1]} id={mcpMatch[1]} />

  // Integration detail: connectors/{provider}/{capability}
  const intMatch = subPath.match(/^connectors\/([^/]+)\/([^/]+)$/)
  if (intMatch) {
    const [, provider, capability] = intMatch
    if (provider === 'local-exchange' && capability === 'calendar') {
      return <LazyLocalExchangeDetail />
    }
    const meta = getIntegration(provider, capability)
    if (meta) {
      return <LazyIntegrationDetail provider={provider} capability={capability} name={meta.name} description={meta.description} />
    }
  }

  return null
}

function SettingsLoader() {
  return (
    <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
      Loading...
    </div>
  )
}

// ── Provider + overlay ─────────────────────────────────────────────

export function SettingsOverlayProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [subPath, setSubPath] = useState('')
  const pathname = usePathname()
  const router = useRouter()
  const prevPathname = useRef(pathname)

  // Auto-close overlay when a route change happens (e.g. clicking into an
  // integration detail page triggers router.push from inside the overlay)
  useEffect(() => {
    if (prevPathname.current !== pathname && isOpen) {
      setIsOpen(false)
    }
    prevPathname.current = pathname
  }, [pathname, isOpen])

  const openSettings = useCallback((path?: string) => {
    setSubPath(normalizeSettingsSubPath(path || ''))
    setIsOpen(true)
  }, [])

  const closeSettings = useCallback(() => {
    setIsOpen(false)
  }, [])

  // Navigate within the overlay (used by SettingsShell links + settings views).
  const handleNavigate = useCallback((path: string) => {
    // Settings sub-pages stay inside the overlay (no route change).
    const match = path.match(/^\/account\/settings\/?(.*)$/)
    if (match) {
      setSubPath(normalizeSettingsSubPath(match[1] || ''))
      return
    }
    // Non-settings destinations (e.g. the Voice view's "Teach Dial8" CTA →
    // /account/voice-enrollment) have no overlay equivalent — close the overlay
    // and hard-navigate to the full-page route so the click isn't a silent no-op.
    setIsOpen(false)
    router.push(path)
  }, [router])

  // Listen for OAuth callback events from deep-link handler (desktop)
  // Opens/refreshes the Connectors page in the overlay without a hard navigation
  useEffect(() => {
    return onOAuthCallback(({ success, provider, capability, error }) => {
      if (success) {
        toast.success(`Connected ${provider} ${capability}`)
      } else {
        toast.error(`Integration error: ${error || 'Unknown error'}`)
      }
      // A connect started from the chat's Connections panel claimed this
      // return: the panel refreshes its own statuses, and Settings popping up
      // over the chat would bury it.
      if (consumeOAuthReturnClaim(provider, capability)) return
      // Open or refresh the Connectors page in the overlay
      setSubPath('connectors')
      setIsOpen(true)
    })
  }, [])

  // Listen for soft navigation events (e.g. tray "Settings" click)
  // Opens the settings overlay if the path is a settings path
  useEffect(() => {
    return onSoftNavigate(({ path }) => {
      const match = path.match(/^\/account\/settings\/?(.*)$/)
      if (match) {
        setSubPath(normalizeSettingsSubPath(match[1] || ''))
        setIsOpen(true)
      }
    })
  }, [])

  const resolved = resolveView(subPath)

  return (
    <SettingsOverlayContext.Provider value={{ openSettings, closeSettings, isOpen, subPath }}>
      {children}
      <DialogPrimitive.Root open={isOpen} onOpenChange={(open) => !open && closeSettings()}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Content
            className="fixed inset-0 z-50 bg-sidebar data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-bottom-2 data-[state=open]:slide-in-from-bottom-2 duration-200"
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <DialogPrimitive.Title className="sr-only">Settings</DialogPrimitive.Title>
            <SettingsShell
              isOverlay
              activeSubPath={subPath}
              onNavigate={handleNavigate}
              onClose={closeSettings}
            >
              {/* No visible scrollbar: WebKit swaps the overlay bar for one that
                  takes width (the hover rule on scrollbar-color, tailwind.css),
                  and the centred page jumped sideways each time. It still
                  scrolls by trackpad and wheel. */}
              <div className="scrollbar-hide h-full overflow-y-auto">
                <Suspense fallback={<SettingsLoader />}>
                  {resolved ?? (() => { const Default = settingsViews['']; return Default ? <Default /> : null })()}
                </Suspense>
              </div>
            </SettingsShell>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </SettingsOverlayContext.Provider>
  )
}
