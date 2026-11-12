'use client'

/**
 * The Search performance page's setup blocks, in the first-run look of the
 * Site audit page (icon disc, heading, plain explainer, one clear action):
 *
 *   Connect    nobody here connected the product: connect your Google account.
 *   Choose     a short picker of the sites (properties) your own Google
 *              connections can read, the suggested one preselected.
 *   Reconnect  the connection the reads go through stopped working: who has
 *              to sign in again, and (when that is someone else) choosing
 *              with your own connection instead.
 *   ReadError  a read that failed, said in place (quota, no access, Google
 *              down).
 *
 * The same blocks serve Search Console (page-sized) and Google Analytics
 * (inside its tab, `compact`). Connecting goes through the app's one connect
 * flow (useConnectProvider: a popup on the web, the system browser on the
 * desktop), owned by the page so its return re-reads the status.
 */
import * as React from 'react'
import { BarChart3, KeyRound, Loader2, MousePointerClick, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type {
  AnalyticsPropertyOption,
  AnalyticsSourceView,
  GoogleProduct,
  GoogleProductStatus,
  SearchConsoleSiteOption,
  SearchConsoleSourceView,
} from '@/lib/seo/google/view'
import { cn } from '@/lib/utils'
import { errorCode, errorMessage } from '../api'
import { chooseProperty, chooseSite, googleDetails } from './api'
import { siteKind, siteLabel } from './helpers'

export type ConnectFn = (product: GoogleProduct, loginHint?: string) => void

const WORDS: Record<GoogleProduct, { name: string; thing: string; things: string; use: string; choose: string }> = {
  search_console: { name: 'Google Search Console', thing: 'site', things: 'sites', use: 'Use this site', choose: 'Choose a site' },
  analytics: { name: 'Google Analytics', thing: 'property', things: 'properties', use: 'Use this property', choose: 'Choose a property' },
}

/** The first-run block's frame. `compact` sits inside a tab, not a whole page. */
export function SetupBlock({
  icon: Icon,
  heading,
  children,
  action,
  compact,
  tone = 'primary',
  ...data
}: {
  icon: React.ComponentType<{ className?: string }>
  heading: string
  children?: React.ReactNode
  action?: React.ReactNode
  compact?: boolean
  tone?: 'primary' | 'amber'
} & Record<`data-${string}`, string>) {
  return (
    <div {...data} className={cn('mx-auto flex max-w-lg flex-col items-center gap-3 px-1 text-center', compact ? 'py-10' : 'py-16')}>
      <div
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-full',
          tone === 'amber' ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' : 'bg-primary/10 text-primary',
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{heading}</p>
        {children && <div className="text-xs leading-relaxed text-muted-foreground">{children}</div>}
      </div>
      {action}
    </div>
  )
}

/** Nobody here connected it yet. */
export function ConnectBlock({ product, busy, onConnect, compact }: { product: GoogleProduct; busy: boolean; onConnect: ConnectFn; compact?: boolean }) {
  const sc = product === 'search_console'
  return (
    <SetupBlock
      data-seo-search-connect={product}
      icon={sc ? MousePointerClick : BarChart3}
      heading={sc ? 'See how people find you on Google' : 'See what search visitors do on your site'}
      compact={compact}
      action={
        <Button size="sm" className="h-8" data-seo-search-connect-button="" disabled={busy} onClick={() => onConnect(product)}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          Connect {WORDS[product].name}
        </Button>
      }
    >
      {sc ? (
        <p>
          Google Search Console knows which searches show your site and how many people click. Connect it and this page shows them,
          with the pages that bring people in. Read-only: nothing on your site or account is changed.
        </p>
      ) : (
        <p>
          Google Analytics knows what people do once they arrive: how long they stay, and whether they sign up or buy. Connect it to see
          that for visits from search. Read-only: nothing in your account is changed.
        </p>
      )}
    </SetupBlock>
  )
}

type AnyStatus =
  | { product: 'search_console'; status: GoogleProductStatus<SearchConsoleSiteOption, SearchConsoleSourceView> }
  | { product: 'analytics'; status: GoogleProductStatus<AnalyticsPropertyOption, AnalyticsSourceView> }

interface PickerOption {
  id: string
  account_id: string
  label: string
  sub: string
  title?: string
  disabled: boolean
}

function optionsOf(s: AnyStatus): PickerOption[] {
  if (s.product === 'search_console')
    return s.status.options.map((o) => ({
      id: o.site_url,
      account_id: o.account_id,
      label: siteLabel(o.site_url),
      sub: o.account_email ?? '',
      title: o.verified ? `${siteKind(o.site_url)} · ${o.permission_level}` : 'Not verified in Search Console: verify it there to choose it.',
      disabled: !o.verified,
    }))
  return s.status.options.map((o) => ({
    id: o.property_id,
    account_id: o.account_id,
    label: o.display_name,
    sub: [o.account_display_name, o.account_email].filter(Boolean).join(' · '),
    title: o.property_id,
    disabled: false,
  }))
}

/**
 * The caller's sites (properties) to choose from, the suggested one
 * preselected and marked. Choosing makes it the workspace's: every member
 * reads it through the chooser's connection.
 */
export function ChoosePicker({
  data,
  connecting,
  onConnect,
  onChosen,
  onCancel,
  compact,
}: {
  data: AnyStatus
  connecting: boolean
  onConnect: ConnectFn
  onChosen: () => void
  onCancel?: () => void
  compact?: boolean
}) {
  const { product, status } = data
  const words = WORDS[product]
  const options = React.useMemo(() => optionsOf(data), [data])
  const current = status.source ? (product === 'search_console' ? (status.source as SearchConsoleSourceView).site_url : (status.source as AnalyticsSourceView).property_id) : null
  const initial = (status.suggested && options.some((o) => o.id === status.suggested && !o.disabled) ? status.suggested : null) ?? current ?? options.find((o) => !o.disabled)?.id ?? null
  const [picked, setPicked] = React.useState<string | null>(initial)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Nothing to choose from: no connection of the caller's own, or one that lists nothing.
  if (options.length === 0) {
    const broken = status.my_accounts.find((a) => a.status === 'needs_reconnect')
    if (status.my_accounts.length === 0) {
      return (
        <div data-seo-search-picker="" data-seo-search-picker-empty="">
          <ConnectBlock product={product} busy={connecting} onConnect={onConnect} compact={compact} />
          {onCancel && <CancelLine onCancel={onCancel} />}
        </div>
      )
    }
    return (
      <SetupBlock
        data-seo-search-picker=""
        data-seo-search-picker-empty=""
        icon={KeyRound}
        compact={compact}
        heading={broken ? `Your ${words.name} connection needs signing in again` : `No ${words.things} to choose from`}
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" className="h-8" disabled={connecting} onClick={() => onConnect(product, broken?.email ?? undefined)}>
              {connecting && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              {broken ? 'Reconnect' : 'Connect another account'}
            </Button>
            {onCancel && (
              <Button variant="ghost" size="sm" className="h-8" onClick={onCancel}>
                Cancel
              </Button>
            )}
          </div>
        }
      >
        <p>
          {broken
            ? `Google stopped letting us read ${broken.email ?? 'your account'}. Sign in again to see its ${words.things}.`
            : product === 'search_console'
              ? 'None of your connected Google accounts has a site in Search Console. Add your site there, or connect the account that has it.'
              : 'None of your connected Google accounts can see a Google Analytics property. Connect the account that has one.'}
        </p>
      </SetupBlock>
    )
  }

  const use = async () => {
    const option = options.find((o) => o.id === picked)
    if (!option) return
    setSaving(true)
    setError(null)
    try {
      if (product === 'search_console') await chooseSite(option.id, option.account_id)
      else await chooseProperty(option.id, option.account_id)
      toast(`Reading ${option.label} for everyone here.`)
      onChosen()
    } catch (err) {
      setError(errorMessage(err, `Could not choose that ${words.thing}. Try again in a moment.`))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div data-seo-search-picker={product} className={cn('mx-auto flex max-w-lg flex-col gap-3 px-1', compact ? 'py-6' : 'py-12')}>
      <div className="space-y-1 text-center">
        <p className="text-sm font-medium">{product === 'search_console' ? 'Which site is yours?' : 'Which Google Analytics property is your site’s?'}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Everyone in this workspace sees it, read through your Google connection. You can change it later.
        </p>
      </div>
      <div role="radiogroup" aria-label={words.choose} className="divide-y divide-border rounded-lg border">
        {options.map((o) => {
          const checked = picked === o.id
          return (
            <button
              key={`${o.account_id}:${o.id}`}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={o.disabled}
              title={o.title}
              data-seo-search-option={o.id}
              onClick={() => setPicked(o.id)}
              className={cn(
                'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors first:rounded-t-lg last:rounded-b-lg disabled:cursor-not-allowed disabled:opacity-50',
                checked ? 'bg-foreground/[0.06]' : 'hover:bg-muted/50',
              )}
            >
              <span
                aria-hidden
                className={cn('flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border', checked ? 'border-foreground' : 'border-muted-foreground/50')}
              >
                {checked && <span className="h-1.5 w-1.5 rounded-full bg-foreground" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{o.label}</span>
                {(o.sub || o.disabled) && (
                  <span className="block truncate text-[11px] text-muted-foreground">{o.disabled ? ['Not verified', o.sub].filter(Boolean).join(' · ') : o.sub}</span>
                )}
              </span>
              {o.id === status.suggested && o.id !== current && (
                <span data-seo-search-suggested="" className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium whitespace-nowrap text-emerald-700 dark:text-emerald-400">
                  Matches your website
                </span>
              )}
              {o.id === current && <span className="shrink-0 text-[11px] text-muted-foreground">In use</span>}
            </button>
          )
        })}
      </div>
      {error && (
        <p data-seo-search-pick-error="" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-center gap-2">
        {onCancel && (
          <Button variant="ghost" size="sm" className="h-8" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          size="sm"
          className="h-8"
          data-seo-search-use=""
          disabled={!picked || saving || picked === current}
          title={picked && picked === current ? `This ${words.thing} is already in use` : undefined}
          onClick={() => void use()}
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          {words.use}
        </Button>
      </div>
    </div>
  )
}

function CancelLine({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="-mt-10 flex justify-center pb-6">
      <Button variant="ghost" size="sm" className="h-8" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  )
}

/**
 * The connection the reads go through stopped working. Who signs in again:
 * the viewer (a Reconnect), or someone else (ask them, or choose with your
 * own connection).
 */
export function ReconnectBlock({
  product,
  name,
  isYou,
  email,
  connecting,
  onConnect,
  onChoose,
  compact,
}: {
  product: GoogleProduct
  /** Who chose it (null when unknown). */
  name: string | null
  isYou: boolean
  email: string | null
  connecting: boolean
  onConnect: ConnectFn
  onChoose: () => void
  compact?: boolean
}) {
  const words = WORDS[product]
  return (
    <SetupBlock
      data-seo-search-reconnect={product}
      icon={KeyRound}
      tone="amber"
      compact={compact}
      heading={`${words.name} needs signing in again`}
      action={
        isYou ? (
          <Button size="sm" className="h-8" data-seo-search-reconnect-button="" disabled={connecting} onClick={() => onConnect(product, email ?? undefined)}>
            {connecting && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            Reconnect
          </Button>
        ) : (
          <Button size="sm" className="h-8" data-seo-search-choose="" onClick={onChoose}>
            {words.choose}
          </Button>
        )
      }
    >
      {isYou ? (
        <p>Google stopped letting us read {email ?? 'your account'}. Sign in again and this page picks up where it left off.</p>
      ) : (
        <p>
          This page reads {product === 'search_console' ? 'Search Console' : 'Google Analytics'} through {name ? `${name}’s` : 'another member’s'} Google connection, which stopped
          working. Ask {name ?? 'them'} to reconnect, or choose a {words.thing} with your own connection.
        </p>
      )}
    </SetupBlock>
  )
}

/**
 * A read that failed, said in place. RECONNECT_NEEDED and NO_ACCESS name
 * what to do; QUOTA is a neutral banner (Google asked us to slow down);
 * anything else is the load-failure line with Try again. NOT_CONNECTED and
 * NO_SOURCE never draw here: the page re-reads its status for those.
 */
export function ReadError({
  err,
  product,
  what,
  connecting,
  onConnect,
  onChoose,
  onRetry,
}: {
  err: unknown
  product: GoogleProduct
  /** "your searches", "this report". */
  what: string
  connecting: boolean
  onConnect: ConnectFn
  onChoose: () => void
  onRetry: () => void
}) {
  const code = errorCode(err)
  const details = googleDetails(err)
  if (code === 'RECONNECT_NEEDED') {
    const by = details?.reconnect_by ?? null
    return (
      <ReconnectBlock
        product={product}
        name={by?.name ?? null}
        isYou={!!by?.is_you}
        email={null}
        connecting={connecting}
        onConnect={onConnect}
        onChoose={onChoose}
        compact
      />
    )
  }
  if (code === 'NO_ACCESS') {
    const words = WORDS[product]
    return (
      <SetupBlock
        data-seo-search-no-access={product}
        icon={ShieldAlert}
        tone="amber"
        compact
        heading={`Your Google account can no longer read this ${words.thing}`}
        action={
          <Button size="sm" className="h-8" data-seo-search-choose="" onClick={onChoose}>
            {words.choose}
          </Button>
        }
      >
        <p>Its access in {words.name} may have changed. Check it there, or choose another {words.thing}.</p>
      </SetupBlock>
    )
  }
  if (code === 'QUOTA') {
    return (
      <div data-seo-search-quota="" className="mt-2 flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <p className="min-w-0 flex-1">Google is limiting requests right now. Try again in a minute.</p>
        <Button variant="ghost" size="sm" className="-my-1 h-7 shrink-0 text-xs" onClick={onRetry}>
          Try again
        </Button>
      </div>
    )
  }
  return (
    <div data-seo-error="" className="flex min-h-40 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <p className="text-sm text-muted-foreground">Could not load {what} from Google.</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}
