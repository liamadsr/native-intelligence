'use client'

/**
 * The agent panel's People tab (guest access, PR5; the design is the "Guests
 * for your agent" page, #people): everyone who can reach the agent, and the
 * one place access is given and taken away.
 *
 *   Asking to reach   people who texted "JOIN <code>": Household, Colleague
 *                     or Ignore. Only shown while someone is waiting.
 *   Who can reach     everyone you added (not you: Liam, 2026-10-25, "it's
 *                     supposed to be other people"): invited (hasn't
 *                     joined yet) or active, with how they reach the agent
 *                     and their preset. A row opens that person's page; its
 *                     menu changes the preset, makes a new invite link, or
 *                     removes them.
 *   Add a person      name, where they reach the agent (Text, Slack or both;
 *                     "Their agent", agent to agent, is built separately and
 *                     shows as coming), their number when it's Text, and
 *                     Household or Colleague, with "Choose
 *                     what they can do": the connector page's Tool
 *                     permissions over every tool a guest can be given (Liam,
 *                     2026-10-24: reuse it, a whole section or tool by tool). Create invite shows the invite once: a
 *                     QR code and the text their phone sends, and what to DM
 *                     the Dial8 app on Slack.
 *   A person's page   where they reach it, their preset, what their agent can do (Tool
 *                     permissions, saved as you go), what always asks you, your notes for their
 *                     agent, the addresses their calendar invites come from (migration 455:
 *                     their invites count as your own plans), a new invite link, and Remove
 *                     access.
 *   Let people ask    your request code: off until you turn it on.
 *
 * Reads and writes /api/account/agent-guests (the owner's own rows). Nothing
 * here texts anyone: guests always text first. Drawn from the panel's own
 * parts (the reach tabs' section, row and icon-tile pattern, Button, Input,
 * Switch, Textarea, DropdownMenu, ConfirmDialog, QrCode) and the connector
 * page's Tool permissions (tool-permission-controls.tsx); nothing new.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, Check, ChevronDown, Copy, Link2, Loader2, MessageSquareText, MoreHorizontal, UserPlus, Users, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { QrCode } from '@/components/ui/qr-code'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  GUEST_ASK_BEFORE_LABELS,
  GUEST_PRESETS,
  GUEST_TOOL_SECTIONS,
  guestToolAsksByDefault,
  guestToolLabel,
  presetSettings,
  type GuestAskBefore,
  type GuestPresetId,
  type GuestPresetValue,
} from '@/lib/guests/presets'
import { GUEST_ALWAYS_TOOLS } from '@/lib/guests/tools'
import { getToolSideEffect } from '@/lib/ai/tool-registry'
import type { ToolPermission } from '@/lib/mcp-client/tool-permissions'
import { ToolPermissionGroup, rowsPermission, type ToolPermissionRow } from '@/components/tool-permissions/tool-permission-controls'
import { GUEST_CHANNEL_LABELS, cleanCalendarEmails, splitCalendarEmails, type GuestInvite, type GuestView } from '@/lib/guests/people'
import type { GuestChannelId } from '@/lib/guests/store'
import type { LinkCandidate, LinkView } from '@/lib/agent-links/views'
import { digitsAfterEdit, formatE164ForDisplay, formatNanp, isCompleteNanp, isImpossibleNanp, nanpE164, smsQrPayload } from '@/lib/sms/phone-format'
import { cn } from '@/lib/utils'
import type { ReachTab } from './communication-panel'

// ── Reads ───────────────────────────────────────────────────────────────────

/** GET /api/account/phone, the part People reads. */
interface PhoneRead {
  phone: { number: string; optedOut: boolean } | null
  available: boolean
}
/** GET /api/account/integrations/slack, the part People reads. */
interface SlackRead {
  configured: boolean
  installations?: Array<{ teamId: string; teamName: string; myLink: { slackUserName: string } | null }>
}
/** GET /api/account/agent-guests. */
interface PeopleRead {
  guests: GuestView[]
  requests: { code: string; open: boolean } | null
  dial8Number: string | null
  available: boolean
}

/** GET /api/account/agent-links: links with other people's agents, and teammates who could be linked. */
interface LinksRead {
  links: LinkView[]
  candidates: LinkCandidate[]
}

interface Access {
  phone: PhoneRead | null
  slack: SlackRead | null
  /** null when the guest routes can't be read (the tab then shows nothing to change). */
  people: PeopleRead | null
  /** null when agent links can't be read: Their agent is then off. */
  links: LinksRead | null
}

const read = <T,>(url: string) =>
  fetch(url)
    .then((r) => (r.ok ? (r.json() as Promise<T>) : null))
    .catch(() => null)

/** Every read, again each time People is shown (a number linked on Phone shows here at once). */
function useAccess(active: boolean): [Access | null, (update: (people: PeopleRead) => PeopleRead) => void, () => Promise<void>] {
  const [access, setAccess] = useState<Access | null>(null)
  const readAll = useCallback(
    () =>
      Promise.all([
        read<PhoneRead>('/api/account/phone'),
        read<SlackRead>('/api/account/integrations/slack'),
        read<PeopleRead>('/api/account/agent-guests'),
        read<LinksRead>('/api/account/agent-links'),
      ]).then(([phone, slack, people, links]) => ({ phone, slack, people, links })),
    [],
  )
  useEffect(() => {
    if (!active) return
    let cancelled = false
    void readAll().then((next) => {
      if (!cancelled) setAccess(next)
    })
    return () => {
      cancelled = true
    }
  }, [active, readAll])
  const updatePeople = useCallback((update: (people: PeopleRead) => PeopleRead) => {
    setAccess((current) => (current?.people ? { ...current, people: update(current.people) } : current))
  }, [])
  // After a link changes both lists (a half comes or goes with it): read them again.
  const reload = useCallback(() => readAll().then(setAccess), [readAll])
  return [access, updatePeople, reload]
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  return body?.error ?? fallback
}

async function send<T>(url: string, method: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) return { ok: false, error: await errorOf(res, 'Couldn’t save that. Try again.') }
    return { ok: true, data: (await res.json()) as T }
  } catch {
    return { ok: false, error: 'Couldn’t reach Dial8. Check your connection and try again.' }
  }
}

// ── Small parts ─────────────────────────────────────────────────────────────

function IconTile({ children }: { children: ReactNode }) {
  return <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted">{children}</span>
}

/** A bordered section with an icon-tile heading and an optional action on the right. */
function Section({ icon, title, action, children, ...rest }: { icon: ReactNode; title: string; action?: ReactNode; children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <section className="rounded-xl border p-3" {...rest}>
      <div className="flex min-h-7 items-center gap-3">
        <IconTile>{icon}</IconTile>
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h3>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}

function Initials({ name }: { name: string }) {
  return (
    <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
      {initialsOf(name)}
    </span>
  )
}

/** "5 min ago", "2 h ago", "3 d ago". */
export function ago(at: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

function presetLabel(preset: GuestPresetValue): string {
  // A business's customer is never listed here (store.ts listGuests), but the type allows it.
  if (preset === 'customer') return 'Customer'
  return preset === 'custom' ? 'Custom' : GUEST_PRESETS[preset].label
}

/** "Text and Slack", "Slack". */
function channelsLabel(channels: readonly GuestChannelId[]): string {
  return channels.map((c) => GUEST_CHANNEL_LABELS[c]).join(' and ')
}

/** A guest's line under their name: how they reach the agent, then where they are. */
export function statusOf(guest: GuestView, now: number = Date.now(), link?: LinkView): string {
  const lead = guest.channels
    .map((c) => (c === 'sms' && guest.masked ? `Text ${guest.masked}` : c === 'dial8' && link?.peer.workspaceName && !link.peer.sameWorkspace ? `Their agent in ${link.peer.workspaceName}` : GUEST_CHANNEL_LABELS[c]))
    .join(' · ')
  const verb = guest.channels.includes('slack') ? 'messaged' : 'texted'
  if (guest.optedOut) return `${lead} · texted STOP`
  // Their agent alone: where the link is.
  if (guest.channels.length === 1 && guest.channels[0] === 'dial8') {
    if (!link || link.state === 'requested') return `${lead} · asked, waiting for them to accept`
    return `${lead} · ${link.lastExchangeAt ? `talked ${ago(link.lastExchangeAt, now)}` : 'linked, hasn’t talked yet'}`
  }
  if (guest.state === 'invited') {
    const expired = guest.inviteExpiresAt !== null && Date.parse(guest.inviteExpiresAt) <= now
    return `${lead} · ${expired ? 'invite expired' : `invited, hasn’t ${verb} yet`}`
  }
  if (guest.state === 'requested') return `${lead}${guest.requestedAt ? ` · asked ${ago(guest.requestedAt, now)}` : ''}`
  const last = guest.lastInboundAt ? `${verb} ${ago(guest.lastInboundAt, now)}` : `hasn’t ${verb} yet`
  const pending = [...guest.unbound, ...(guest.channels.includes('dial8') && link?.state === 'requested' ? (['dial8'] as const) : [])]
  return `${lead} · ${last}${pending.length > 0 ? ` · not on ${channelsLabel(pending)} yet` : ''}`
}

const TEXT_BUTTON =
  'shrink-0 rounded-md px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'

/** The tab's one black action (the reach card's, at the tab's size). */
const PRIMARY = 'h-9 rounded-lg bg-foreground px-4 text-sm font-medium text-background hover:bg-foreground/90'

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-2 text-xs text-destructive">
      {children}
    </p>
  )
}

/** What a person's agent can do: held tools, and of those the ones that ask. */
export interface GuestPicks {
  tools: string[]
  askTools: string[]
  askBefore: GuestAskBefore[]
}

/** A tool's permission in these picks. */
export function pickedPermission(picks: Pick<GuestPicks, 'tools' | 'askTools'>, name: string): ToolPermission {
  if (!picks.tools.includes(name)) return 'blocked'
  return picks.askTools.includes(name) ? 'ask' : 'allow'
}

/**
 * These picks with `names` set to `permission`, exactly: the owner decides
 * every tool, an outward one or a delete included (Liam, 2026-11-02). Each
 * tool's own setting is the truth from here, so "any change at all"
 * (askBefore changes, which a preset can start with) comes off, keeping what
 * it held for deletes and payments; and a delete set to Always allow turns
 * "Deleting anything asks you first" off (the other deletes keep their own
 * settings).
 */
export function withPicked(picks: GuestPicks, names: readonly string[], permission: ToolPermission): GuestPicks {
  const set = new Set(names)
  const allowsADelete = permission === 'allow' && names.some((n) => getToolSideEffect(n) === 'delete')
  const askBefore = withoutAnyChange(picks.askBefore).filter((a) => !(allowsADelete && a === 'deletes'))
  const tools = picks.tools.filter((t) => !set.has(t))
  const askTools = picks.askTools.filter((t) => !set.has(t))
  if (permission !== 'blocked') tools.push(...names)
  if (permission === 'ask') askTools.push(...names)
  return { tools, askTools, askBefore }
}

/**
 * A whole section set at once. Always allow there turns every tool on, but a
 * tool that sends or changes something outside Dial8, or deletes, stays on
 * Needs approval unless it already was Always allow: one click on a section
 * never lets those run without a card. Each is set on its own row. Every
 * other choice is withPicked's.
 */
export function withSectionPicked(picks: GuestPicks, names: readonly string[], permission: ToolPermission): GuestPicks {
  if (permission !== 'allow') return withPicked(picks, names, permission)
  const careful = names.filter((n) => guestToolAsksByDefault(n, ['deletes']) && pickedPermission(picks, n) !== 'allow')
  const allowed = withPicked(picks, names.filter((n) => !careful.includes(n)), 'allow')
  return careful.length ? withPicked(allowed, careful, 'ask') : allowed
}

/** Asks without "any change at all": what it covered for deletes and payments becomes their own asks. */
function withoutAnyChange(askBefore: readonly GuestAskBefore[]): GuestAskBefore[] {
  if (!askBefore.includes('changes')) return [...askBefore]
  return [...new Set<GuestAskBefore>([...askBefore.filter((a) => a !== 'changes'), 'payments', 'deletes'])]
}

/** True when this ask is on for these picks ("any change at all" covers both). */
export function askIsOn(picks: Pick<GuestPicks, 'askBefore'>, ask: 'payments' | 'deletes'): boolean {
  return picks.askBefore.includes(ask) || picks.askBefore.includes('changes')
}

/**
 * These picks with "Paying for anything" or "Deleting anything asks you
 * first" switched. Deletes on puts every held delete on Needs approval; off
 * sets them to Always allow (the owner can still set one back by hand).
 */
export function withAsk(picks: GuestPicks, ask: 'payments' | 'deletes', on: boolean): GuestPicks {
  const rest = withoutAnyChange(picks.askBefore).filter((a) => a !== ask)
  const askBefore = on ? [...rest, ask] : rest
  if (ask === 'payments') return { ...picks, askBefore }
  const deletes = new Set(picks.tools.filter((t) => getToolSideEffect(t) === 'delete'))
  const askTools = on ? [...new Set([...picks.askTools, ...deletes])] : picks.askTools.filter((t) => !deletes.has(t))
  return { ...picks, askTools, askBefore }
}

/**
 * What a person's agent can do, as the connector page's Tool permissions:
 * every tool a guest can be given, by section, each Always allow / Needs
 * approval / Blocked, a section at once from its menu. Then the tools every
 * guest's agent has, and paying for anything, which can only ask.
 */
export function GuestToolPermissions({ picks, onChange, disabled }: { picks: GuestPicks; onChange: (picks: GuestPicks) => void; disabled?: boolean }) {
  const always = new Set<string>(GUEST_ALWAYS_TOOLS)
  const sections = GUEST_TOOL_SECTIONS.map((section) => ({ ...section, tools: section.tools.filter((t) => !always.has(t)) })).filter((s) => s.tools.length > 0)
  const paymentsAsk = askIsOn(picks, 'payments')
  const deletesAsk = askIsOn(picks, 'deletes')
  return (
    <div data-people-tools="">
      <div className="space-y-1">
        {sections.map((section) => {
          const rows: ToolPermissionRow[] = section.tools.map((name) => ({
            name,
            label: guestToolLabel(name),
            value: pickedPermission(picks, name),
          }))
          return (
            <ToolPermissionGroup
              key={section.id}
              title={section.label}
              rows={rows}
              value={rowsPermission(rows) ?? 'blocked'}
              defaultOpen={false}
              disabled={disabled}
              onSetGroup={(p) => onChange(withSectionPicked(picks, section.tools, p))}
              onSetTool={(name, p) => onChange(withPicked(picks, [name], p))}
            />
          )
        })}
      </div>
      <ul className="mt-3 divide-y rounded-lg border">
        <li className="flex items-center gap-3 px-3 py-2" data-people-ask="payments">
          <span className="min-w-0 flex-1">
            <span className="block text-sm">{GUEST_ASK_BEFORE_LABELS.payments} asks you first</span>
            <span className="block text-xs text-muted-foreground">Browser tasks (a booking, an order) wait for your OK, and stop before they pay.</span>
          </span>
          <Switch
            checked={paymentsAsk}
            onCheckedChange={(on) => onChange(withAsk(picks, 'payments', on))}
            disabled={disabled}
            aria-label={`${GUEST_ASK_BEFORE_LABELS.payments} asks you first`}
          />
        </li>
        <li className="flex items-center gap-3 px-3 py-2" data-people-ask="deletes">
          <span className="min-w-0 flex-1">
            <span className="block text-sm">{GUEST_ASK_BEFORE_LABELS.deletes} asks you first</span>
            <span className="block text-xs text-muted-foreground">Off: each delete tool follows its own setting above.</span>
          </span>
          <Switch
            checked={deletesAsk}
            onCheckedChange={(on) => onChange(withAsk(picks, 'deletes', on))}
            disabled={disabled}
            aria-label={`${GUEST_ASK_BEFORE_LABELS.deletes} asks you first`}
          />
        </li>
        <li className="px-3 py-2 text-xs text-muted-foreground">Always: message you, ask your main agent for anything it can&apos;t do, and remember how they like things done.</li>
      </ul>
    </div>
  )
}

/** Household or Colleague, as two cards side by side. */
function PresetPicker({ value, onChange, name, disabled }: { value: GuestPresetValue; onChange: (preset: GuestPresetId) => void; name: string; disabled?: boolean }) {
  const blurb: Record<GuestPresetId, string> = {
    household: `Can ask ${name} to do things for you, as you would by text.`,
    colleague: 'Can see when you’re free and leave you messages.',
  }
  return (
    <div role="radiogroup" aria-label="What they can do" className="grid grid-cols-2 gap-2">
      {(['household', 'colleague'] as const).map((id) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          disabled={disabled}
          onClick={() => onChange(id)}
          data-people-preset={id}
          className={cn(
            'rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
            value === id ? 'border-foreground/40 bg-muted/40' : 'hover:bg-muted/30',
          )}
        >
          <span className="block text-sm font-medium">{GUEST_PRESETS[id].label}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{blurb[id]}</span>
        </button>
      ))}
    </div>
  )
}

/** Where people can reach the agent on this Dial8: Text needs the Dial8 number, Slack a workspace with the Dial8 app. */
interface Reach {
  text: boolean
  slackTeam: string | null
  /** Opens the Slack tab, when Slack can be added here. */
  setUpSlack?: () => void
  /** Agent links can be read here (Their agent can be picked). */
  links: boolean
}

/**
 * Where they reach the agent: Text, Slack, their own Dial8 agent, or any of
 * them, as cards like the presets (at least one stays picked). `fixed` are
 * shown but not toggled here (a linked person's agent: Disconnect ends it).
 */
function ChannelPicker({
  value,
  onChange,
  reach,
  disabled,
  fixed = [],
}: {
  value: readonly GuestChannelId[]
  onChange: (channels: GuestChannelId[]) => void
  reach: Reach
  disabled?: boolean
  fixed?: readonly GuestChannelId[]
}) {
  const toggle = (id: GuestChannelId) => {
    const next = (['sms', 'slack', 'dial8'] as const).filter((c) => (c === id ? !value.includes(c) : value.includes(c)))
    if (next.length > 0) onChange(next)
  }
  const cards: Array<{ id: GuestChannelId; blurb: string; available: boolean }> = [
    { id: 'sms', blurb: reach.text ? 'They text the Dial8 number.' : 'Texting isn’t set up on this Dial8 yet.', available: reach.text },
    { id: 'slack', blurb: reach.slackTeam ? `They DM the Dial8 app in ${reach.slackTeam}.` : 'Add Dial8 to your Slack first.', available: reach.slackTeam !== null },
    {
      id: 'dial8',
      blurb: reach.links ? 'Their Dial8 agent and yours can ask each other. They accept first.' : 'Agent links aren’t set up on this Dial8 yet.',
      available: reach.links,
    },
  ]
  const card = 'rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
  return (
    <div>
      <div role="group" aria-label="Where they reach your agent" className="grid grid-cols-3 gap-2">
        {cards.map(({ id, blurb, available }) => {
          const on = value.includes(id)
          return (
            <button
              key={id}
              type="button"
              role="checkbox"
              aria-checked={on}
              // A channel that isn't available can still be turned off, never on.
              disabled={disabled || (!available && !on) || fixed.includes(id)}
              onClick={() => toggle(id)}
              data-people-channel-pick={id}
              className={cn(card, on ? 'border-foreground/40 bg-muted/40' : 'hover:bg-muted/30')}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{GUEST_CHANNEL_LABELS[id]}</span>
                {on && <Check aria-hidden className="size-3.5 text-foreground" />}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{blurb}</span>
            </button>
          )
        })}
      </div>
      {!reach.slackTeam && reach.setUpSlack && (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
          Slack isn&apos;t connected yet.
          <button type="button" onClick={reach.setUpSlack} className={TEXT_BUTTON} data-people-set-up-slack="">
            Set up Slack
          </button>
        </p>
      )}
    </div>
  )
}

/** Which teammate's agent: the workspace's people not linked or asked yet, one at a time. */
function TeammatePicker({ candidates, value, onChange, disabled }: { candidates: LinkCandidate[]; value: string | null; onChange: (c: LinkCandidate) => void; disabled?: boolean }) {
  if (candidates.length === 0) {
    return (
      <p className="rounded-lg border px-3 py-2 text-xs text-muted-foreground" data-people-teammates="">
        Everyone in this workspace is linked or asked already.
      </p>
    )
  }
  return (
    <ul role="radiogroup" aria-label="Whose agent" className="max-h-44 divide-y overflow-y-auto rounded-lg border" data-people-teammates="">
      {candidates.map((c) => (
        <li key={c.userId}>
          <button
            type="button"
            role="radio"
            aria-checked={value === c.userId}
            disabled={disabled}
            onClick={() => onChange(c)}
            data-people-teammate={c.userId}
            className={cn(
              'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50',
              value === c.userId ? 'bg-muted/40' : 'hover:bg-muted/30',
            )}
          >
            <Initials name={c.name} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{c.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{c.agentName ? `Their agent is ${c.agentName}` : 'In this workspace'}</span>
            </span>
            {value === c.userId && <Check aria-hidden className="size-3.5 shrink-0 text-foreground" />}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** The +1 number field, NANP formatted as you type. */
function PhoneField({ digits, onChange, disabled }: { digits: string; onChange: (digits: string) => void; disabled?: boolean }) {
  const impossible = isImpossibleNanp(digits)
  return (
    <Input
      value={digits ? `+1 ${formatNanp(digits)}` : ''}
      onChange={(e) => onChange(digitsAfterEdit(digits, e.target.value.replace(/^\+1\s?/, ''), null).digits)}
      type="tel"
      inputMode="tel"
      placeholder="+1 (555) 000-0000"
      aria-label="Their mobile number"
      aria-invalid={impossible || undefined}
      disabled={disabled}
      className={cn('tabular-nums', impossible && 'border-destructive')}
      data-people-phone=""
    />
  )
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* no clipboard: it's on screen to type */
    }
  }
  return (
    <button type="button" onClick={copy} className={cn(TEXT_BUTTON, 'flex items-center gap-1.5')} aria-label={copied ? 'Copied' : label} data-people-copy="">
      {copied ? <Check aria-hidden className="size-3.5 text-emerald-500" /> : <Copy aria-hidden className="size-3.5 text-muted-foreground" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

// ── Views ───────────────────────────────────────────────────────────────────

type View =
  | { kind: 'list' }
  | { kind: 'add' }
  | { kind: 'invite'; guest: GuestView; invite: GuestInvite }
  | { kind: 'person'; id: string }
  | { kind: 'review'; linkId: string }
  | ({ kind: 'sent' } & Linked)

/** An agent link just asked for: by email, or a connect link to send; with Text or Slack's invite when they came too. */
interface Linked {
  displayName: string
  guest: GuestView | null
  invite: GuestInvite | null
  email?: string
  url?: string
}

/** GET /api/account/agent-links/answer-workspaces: one of yours answers a link. */
interface AnswerWorkspace {
  id: string
  name: string
  /** The workspace admin's switch: off means an outside link can't be answered from it. */
  outsideAllowed: boolean
}

/** Who Their agent is: a teammate, anyone by email, or a connect link you send yourself. */
type AgentBy = 'teammate' | 'email' | 'link'

export function PeoplePanel({
  name,
  active,
  onOpenTab,
  focusGuestId,
  focusLinkId,
}: {
  name: string
  active: boolean
  onOpenTab: (tab: ReachTab) => void
  /** Land on this person: their page, or their request highlighted. */
  focusGuestId?: string
  /** Land on this agent link request, to review (a connect link just opened). */
  focusLinkId?: string
}) {
  const [access, updatePeople, reload] = useAccess(active)
  const [view, setView] = useState<View>({ kind: 'list' })
  const [highlight, setHighlight] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const landed = useRef(false)

  const people = access?.people ?? null
  const guests = people?.guests ?? []
  const reach: Reach = {
    text: access?.phone?.available !== false && Boolean(people?.dial8Number),
    slackTeam: access?.slack?.installations?.[0]?.teamName ?? null,
    setUpSlack: access?.slack?.configured === false ? undefined : () => onOpenTab('slack'),
    links: Boolean(access?.links),
  }
  const links = access?.links?.links ?? []
  const linkFor = (guest: GuestView) => links.find((l) => l.myHalfGuestId === guest.id)
  const asking = links.filter((l) => l.direction === 'incoming' && l.state === 'requested')

  // A chat card's "Manage in People", or a connect link's request: once, when the lists first arrive.
  useEffect(() => {
    if (landed.current || !access) return
    if (focusLinkId) {
      landed.current = true
      const link = access.links?.links.find((l) => l.id === focusLinkId)
      if (link?.state === 'requested' && link.direction === 'incoming') setView({ kind: 'review', linkId: link.id })
      else if (link?.myHalfGuestId) setView({ kind: 'person', id: link.myHalfGuestId })
      return
    }
    if (!focusGuestId || !people) return
    landed.current = true
    const guest = people.guests.find((g) => g.id === focusGuestId)
    if (!guest) return
    if (guest.state === 'requested') setHighlight(guest.id)
    else setView({ kind: 'person', id: guest.id })
  }, [focusGuestId, focusLinkId, people, access])

  const replaceGuest = (guest: GuestView) =>
    updatePeople((p) => ({ ...p, guests: p.guests.some((g) => g.id === guest.id) ? p.guests.map((g) => (g.id === guest.id ? guest : g)) : [guest, ...p.guests] }))
  const dropGuest = (id: string) => updatePeople((p) => ({ ...p, guests: p.guests.filter((g) => g.id !== id) }))

  if (access === null) {
    return (
      <div data-communication="people">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    )
  }

  if (view.kind === 'person') {
    const guest = guests.find((g) => g.id === view.id)
    if (guest) {
      return (
        <div data-communication="people">
          <PersonPage
            guest={guest}
            link={linkFor(guest)}
            candidates={access.links?.candidates ?? []}
            agentName={name}
            reach={reach}
            onLinksChanged={reload}
            onBack={() => setView({ kind: 'list' })}
            onChanged={replaceGuest}
            onRemoved={() => {
              dropGuest(guest.id)
              setView({ kind: 'list' })
            }}
            onInvite={(g, invite) => {
              replaceGuest(g)
              setView({ kind: 'invite', guest: g, invite })
            }}
          />
        </div>
      )
    }
  }

  if (view.kind === 'review') {
    const link = links.find((l) => l.id === view.linkId)
    if (link) {
      return (
        <div data-communication="people">
          <ReviewLink
            link={link}
            agentName={name}
            onBack={() => setView({ kind: 'list' })}
            onAccepted={async (accepted) => {
              await reload()
              setView(accepted.myHalfGuestId ? { kind: 'person', id: accepted.myHalfGuestId } : { kind: 'list' })
            }}
          />
        </div>
      )
    }
  }

  const requests = guests.filter((g) => g.state === 'requested')
  const listed = guests.filter((g) => g.state === 'invited' || g.state === 'active')

  return (
    <div className="space-y-3" data-communication="people">
      {view.kind === 'add' && people && (
        <AddPerson
          agentName={name}
          reach={reach}
          candidates={access.links?.candidates ?? []}
          onCancel={() => setView({ kind: 'list' })}
          onCreated={(guest, invite) => {
            replaceGuest(guest)
            setView({ kind: 'invite', guest, invite })
          }}
          onLinked={async (linked, error) => {
            await reload()
            setNotice(error ?? null)
            if (linked.email || linked.url) return setView({ kind: 'sent', ...linked })
            setView(linked.guest && linked.invite ? { kind: 'invite', guest: linked.guest, invite: linked.invite } : { kind: 'list' })
          }}
        />
      )}
      {view.kind === 'sent' && <SentCard linked={view} onDone={() => setView({ kind: 'list' })} />}
      {view.kind === 'sent' && view.guest && view.invite && (
        <InviteCard guest={view.guest} invite={view.invite} agentName={name} slackTeam={reach.slackTeam} onDone={() => setView({ kind: 'list' })} />
      )}
      {view.kind === 'invite' && <InviteCard guest={view.guest} invite={view.invite} agentName={name} slackTeam={reach.slackTeam} onDone={() => setView({ kind: 'list' })} />}

      {notice && <ErrorLine>{notice}</ErrorLine>}
      {asking.length > 0 && (
        <Section icon={<Link2 aria-hidden className="size-3.5 text-muted-foreground" />} title={`Agents asking to talk to ${name}`} data-people-link-requests="">
          <ul className="space-y-2">
            {asking.map((link) => (
              <LinkRequestRow key={link.id} link={link} onReview={() => setView({ kind: 'review', linkId: link.id })} onIgnored={reload} />
            ))}
          </ul>
        </Section>
      )}

      {requests.length > 0 && (
        <Section icon={<UserPlus aria-hidden className="size-3.5 text-muted-foreground" />} title={`Asking to reach ${name}`} data-people-requests="">
          <ul className="space-y-2">
            {requests.map((guest) => (
              <RequestRow key={guest.id} guest={guest} highlighted={highlight === guest.id} onSettled={(next) => (next ? replaceGuest(next) : dropGuest(guest.id))} />
            ))}
          </ul>
        </Section>
      )}

      <Section
        icon={<Users aria-hidden className="size-3.5 text-muted-foreground" />}
        title={`Who can reach ${name}`}
        action={
          people && view.kind !== 'add' ? (
            <button type="button" onClick={() => setView({ kind: 'add' })} className={cn(TEXT_BUTTON, 'flex items-center gap-1.5')} data-people-add="">
              <UserPlus aria-hidden className="size-3.5" />
              Add a person
            </button>
          ) : undefined
        }
        data-people-who=""
      >
        {listed.length > 0 && (
          <ul className="space-y-2">
            {listed.map((guest) => (
              <GuestRow
                key={guest.id}
                guest={guest}
                link={linkFor(guest)}
                onLinksChanged={reload}
                onOpen={() => setView({ kind: 'person', id: guest.id })}
                onChanged={replaceGuest}
                onRemoved={() => dropGuest(guest.id)}
                onInvite={(g, invite) => {
                  replaceGuest(g)
                  setView({ kind: 'invite', guest: g, invite })
                }}
              />
            ))}
          </ul>
        )}
        {listed.length === 0 && (
          <p className="text-xs text-muted-foreground" data-people-others="">
            No one else can talk to {name} yet. Add someone and they get their own {name}, by Text, Slack or their own agent, with only what you choose. A message
            from anyone else gets a note that it isn&apos;t linked.
          </p>
        )}
      </Section>

      {people?.requests && (
        <LetPeopleAsk
          state={people.requests}
          dial8Number={people.dial8Number}
          name={name}
          onChange={(requests) => updatePeople((p) => ({ ...p, requests }))}
        />
      )}
    </div>
  )
}

/** Someone who texted JOIN: allow as Household or Colleague, or ignore. */
function RequestRow({ guest, highlighted, onSettled }: { guest: GuestView; highlighted: boolean; onSettled: (guest: GuestView | null) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const row = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (highlighted) row.current?.scrollIntoView?.({ block: 'nearest' })
  }, [highlighted])

  const settle = async (to: GuestPresetId | 'ignore') => {
    setBusy(true)
    setError(null)
    const result =
      to === 'ignore'
        ? await send<{ ok: true }>(`/api/account/agent-guests/${guest.id}/ignore`, 'POST')
        : await send<{ guest: GuestView }>(`/api/account/agent-guests/${guest.id}/approve`, 'POST', { preset: to })
    setBusy(false)
    if (!result.ok) return setError(result.error)
    onSettled(to === 'ignore' ? null : (result.data as { guest: GuestView }).guest)
  }

  return (
    <li ref={row} className={cn('rounded-lg border px-3 py-2', highlighted && 'border-foreground/40 bg-muted/30')} data-people-request={guest.id}>
      <div className="flex flex-wrap items-center gap-3">
        <Initials name={guest.displayName} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{guest.displayName}</span>
          <span className="block truncate text-xs text-muted-foreground">{statusOf(guest)}</span>
        </span>
        <span className="flex items-center gap-0.5">
          {busy && <Loader2 aria-label="Saving" className="mr-1 size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none" />}
          <button type="button" disabled={busy} onClick={() => settle('household')} className={TEXT_BUTTON} data-people-allow="household">
            Household
          </button>
          <button type="button" disabled={busy} onClick={() => settle('colleague')} className={TEXT_BUTTON} data-people-allow="colleague">
            Colleague
          </button>
          <button type="button" disabled={busy} onClick={() => settle('ignore')} className={cn(TEXT_BUTTON, 'text-muted-foreground')} data-people-ignore="">
            Ignore
          </button>
        </span>
      </div>
      {error && <ErrorLine>{error}</ErrorLine>}
    </li>
  )
}

/** "Their agent, Ava · Northwind · asked 5 min ago". */
function linkLine(link: LinkView, now: number = Date.now()): string {
  const who = link.peer.agentName ? `Their agent, ${link.peer.agentName}` : 'Their agent'
  const where = link.peer.workspaceName ? ` · ${link.peer.workspaceName}${link.peer.sameWorkspace ? ', your workspace' : ''}` : ''
  return `${who}${where} · asked ${ago(link.requestedAt, now)}`
}

/** Someone's agent asking to talk to yours: Review (choose what it may ask) or Ignore. */
function LinkRequestRow({ link, onReview, onIgnored }: { link: LinkView; onReview: () => void; onIgnored: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ignore = async () => {
    setBusy(true)
    setError(null)
    const result = await send<{ ok: true }>(`/api/account/agent-links/${link.id}/ignore`, 'POST')
    setBusy(false)
    if (!result.ok) return setError(result.error)
    await onIgnored()
  }
  return (
    <li className="rounded-lg border px-3 py-2" data-people-link-request={link.id}>
      <div className="flex flex-wrap items-center gap-3">
        <Initials name={link.peer.name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{link.peer.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{linkLine(link)}</span>
        </span>
        <span className="flex items-center gap-0.5">
          {busy && <Loader2 aria-label="Saving" className="mr-1 size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none" />}
          <button type="button" disabled={busy} onClick={onReview} className={TEXT_BUTTON} data-people-review-open="">
            Review
          </button>
          <button type="button" disabled={busy} onClick={() => void ignore()} className={cn(TEXT_BUTTON, 'text-muted-foreground')} data-people-link-ignore="">
            Ignore
          </button>
        </span>
      </div>
      {error && <ErrorLine>{error}</ErrorLine>}
    </li>
  )
}

/** The menu's and a person's page's writes: preset, new invite, remove. */
function useGuestActions(
  guest: GuestView,
  on: { onChanged: (g: GuestView) => void; onRemoved: () => void; onInvite: (g: GuestView, invite: GuestInvite) => void; link?: LinkView; onLinksChanged?: () => Promise<void> },
) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async <T,>(url: string, method: string, body: unknown, done: (data: T) => void) => {
    setBusy(true)
    setError(null)
    const result = await send<T>(url, method, body)
    setBusy(false)
    if (!result.ok) return setError(result.error)
    done(result.data)
  }
  return {
    busy,
    error,
    setPreset: (preset: GuestPresetId) => run<{ guest: GuestView }>(`/api/account/agent-guests/${guest.id}`, 'PATCH', { preset }, (d) => on.onChanged(d.guest)),
    patch: (body: Record<string, unknown>) => run<{ guest: GuestView }>(`/api/account/agent-guests/${guest.id}`, 'PATCH', body, (d) => on.onChanged(d.guest)),
    newInvite: () => run<{ guest: GuestView; invite: GuestInvite }>(`/api/account/agent-guests/${guest.id}/invite`, 'POST', undefined, (d) => on.onInvite(d.guest, d.invite)),
    // Their agent goes first: ending the link drops it from both sides (and the row too, when it was all they had).
    remove: async () => {
      if (on.link) {
        setBusy(true)
        setError(null)
        const ended = await send<{ ok: true }>(`/api/account/agent-links/${on.link.id}`, 'DELETE')
        setBusy(false)
        if (!ended.ok) return setError(ended.error)
        if (guest.channels.every((c) => c === 'dial8')) {
          on.onRemoved()
          return void on.onLinksChanged?.()
        }
      }
      await run<{ ok: true }>(`/api/account/agent-guests/${guest.id}`, 'DELETE', undefined, () => on.onRemoved())
      if (on.link) void on.onLinksChanged?.()
    },
    /** Disconnect their agent (or withdraw the request): the rest of how they reach yours stays. */
    disconnect: () => (on.link ? run<{ ok: true }>(`/api/account/agent-links/${on.link.id}`, 'DELETE', undefined, () => void on.onLinksChanged?.()) : Promise.resolve()),
  }
}

/** Still owed an invite on Text or Slack (Their agent joins by accepting, never by a code). */
function invitable(guest: GuestView): boolean {
  const owed = guest.state === 'active' ? guest.unbound : guest.state === 'invited' ? guest.channels : []
  return owed.some((c) => c !== 'dial8')
}

function GuestRow({
  guest,
  link,
  onLinksChanged,
  onOpen,
  onChanged,
  onRemoved,
  onInvite,
}: {
  guest: GuestView
  link?: LinkView
  onLinksChanged: () => Promise<void>
  onOpen: () => void
  onChanged: (g: GuestView) => void
  onRemoved: () => void
  onInvite: (g: GuestView, invite: GuestInvite) => void
}) {
  const actions = useGuestActions(guest, { onChanged, onRemoved, onInvite, link, onLinksChanged })
  const [confirming, setConfirming] = useState(false)
  return (
    <li className="rounded-lg border" data-people-guest={guest.id} data-people-state={guest.state}>
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-l-lg px-3 py-2 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-people-open=""
        >
          <Initials name={guest.displayName} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{guest.displayName}</span>
            <span className="block truncate text-xs text-muted-foreground">{statusOf(guest, undefined, link)}</span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground" data-people-preset-label="">
            {presetLabel(guest.preset)}
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7 shrink-0 shadow-none" aria-label={`More for ${guest.displayName}`} disabled={actions.busy} data-people-menu="">
              {actions.busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <MoreHorizontal />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuRadioGroup value={guest.preset} onValueChange={(v) => (v === 'household' || v === 'colleague') && v !== guest.preset && actions.setPreset(v)}>
              <DropdownMenuRadioItem value="household">Household</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="colleague">Colleague</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuItem onSelect={onOpen}>Choose what they can do</DropdownMenuItem>
            {invitable(guest) && <DropdownMenuItem onSelect={() => actions.newInvite()}>New invite link</DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setConfirming(true)}>
              Remove access
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {actions.error && <div className="px-3 pb-2"><ErrorLine>{actions.error}</ErrorLine></div>}
      <RemoveConfirm guest={guest} open={confirming} onOpenChange={setConfirming} busy={actions.busy} onConfirm={() => void actions.remove().then(() => setConfirming(false))} />
    </li>
  )
}

function RemoveConfirm({ guest, open, onOpenChange, busy, onConfirm }: { guest: GuestView; open: boolean; onOpenChange: (open: boolean) => void; busy: boolean; onConfirm: () => void }) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Remove ${guest.displayName}?`}
      description={`${guest.displayName} can’t reach your agent any more, starting now, and what it learned about them is deleted. To let them back, add them again.`}
      confirmLabel="Remove"
      busy={busy}
      onConfirm={onConfirm}
    />
  )
}

/**
 * Add a person: name, where they reach the agent (with their number for
 * Text, and which teammate for Their agent), a preset, and optionally what
 * exactly they can do. With Their agent the link is asked for first, and its
 * half is the person's one row: Text and Slack are added to it after.
 */
function AddPerson({
  agentName,
  reach,
  candidates,
  onCancel,
  onCreated,
  onLinked,
}: {
  agentName: string
  reach: Reach
  candidates: LinkCandidate[]
  onCancel: () => void
  onCreated: (guest: GuestView, invite: GuestInvite) => void
  /** Asked their agent; with the invite when Text or Slack came too, or what didn't work after asking. */
  onLinked: (linked: Linked, error?: string) => void
}) {
  const [displayName, setDisplayName] = useState('')
  const [channels, setChannels] = useState<GuestChannelId[]>(() => (!reach.text && reach.slackTeam ? ['slack'] : ['sms']))
  const [digits, setDigits] = useState('')
  const [peer, setPeer] = useState<LinkCandidate | null>(null)
  const [by, setBy] = useState<AgentBy>(() => (candidates.length > 0 ? 'teammate' : 'email'))
  const [email, setEmail] = useState('')
  const [preset, setPreset] = useState<GuestPresetId>('household')
  const [picks, setPicks] = useState<GuestPicks>(() => presetSettings('household'))
  const [choosing, setChoosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameField = useRef<HTMLInputElement>(null)
  useEffect(() => nameField.current?.focus(), [])

  const pickPreset = (id: GuestPresetId) => {
    setPreset(id)
    setPicks(presetSettings(id))
  }
  const text = channels.includes('sms')
  const agent = channels.includes('dial8')
  const others = channels.filter((c) => c !== 'dial8')
  const impossible = text && isImpossibleNanp(digits)
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const whoOk = by === 'teammate' ? peer !== null : by === 'email' ? emailOk : true
  const ready = displayName.trim().length > 0 && (!text || isCompleteNanp(digits)) && (!agent || whoOk) && !busy
  const pickPeer = (c: LinkCandidate) => {
    setPeer(c)
    if (!displayName.trim()) setDisplayName(c.name)
  }

  const link = async (): Promise<{ done: Linked; error?: string } | { error: string }> => {
    const half = { displayName: displayName.trim(), preset, tools: picks.tools, askTools: picks.askTools, askBefore: picks.askBefore }
    // The answer to an email is the same whoever it is (it never says whether they're on Dial8).
    const asked =
      by === 'link'
        ? await send<{ link: LinkView | null; url: string }>('/api/account/agent-links/connect', 'POST', half)
        : await send<{ link: LinkView | null; url?: string }>('/api/account/agent-links', 'POST', by === 'email' ? { ...half, email: email.trim() } : { ...half, peerUserId: peer!.userId })
    if (!asked.ok) return { error: asked.error }
    const done: Linked = {
      displayName: half.displayName,
      guest: null,
      invite: null,
      ...(by === 'email' ? { email: email.trim() } : {}),
      ...(by === 'link' && asked.data.url ? { url: asked.data.url } : {}),
    }
    const halfId = asked.data.link?.myHalfGuestId
    if (others.length === 0 || !halfId) return { done }
    // Text and Slack join the half, then its invite.
    const added = await send<{ guest: GuestView }>(`/api/account/agent-guests/${halfId}`, 'PATCH', { channels: others, ...(text ? { phone: nanpE164(digits) } : {}) })
    if (!added.ok) return { done, error: `Asked their agent, but ${channelsLabel(others)} wasn’t added: ${added.error}` }
    const invited = await send<{ guest: GuestView; invite: GuestInvite }>(`/api/account/agent-guests/${halfId}/invite`, 'POST')
    if (!invited.ok) return { done, error: `Asked their agent, but the invite wasn’t made: ${invited.error}` }
    return { done: { ...done, guest: invited.data.guest, invite: invited.data.invite } }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    if (agent) {
      const result = await link()
      setBusy(false)
      // Asked already when there's a result: the list shows them, and their page can add the rest.
      if (!('done' in result)) return setError(result.error)
      return onLinked(result.done, result.error)
    }
    const result = await send<{ guest: GuestView; invite: GuestInvite }>('/api/account/agent-guests', 'POST', {
      displayName: displayName.trim(),
      channels,
      phone: text ? nanpE164(digits) : null,
      preset,
      tools: picks.tools,
      askTools: picks.askTools,
      askBefore: picks.askBefore,
    })
    setBusy(false)
    if (!result.ok) return setError(result.error)
    onCreated(result.data.guest, result.data.invite)
  }

  return (
    <Section
      icon={<UserPlus aria-hidden className="size-3.5 text-muted-foreground" />}
      title="Add a person"
      action={
        <Button variant="ghost" size="icon" className="size-7 shadow-none" onClick={onCancel} aria-label="Cancel">
          <X />
        </Button>
      }
      data-people-adding=""
    >
      <form onSubmit={submit} noValidate className="space-y-3">
        <div className={cn('grid gap-2', text && 'grid-cols-2')}>
          <Input ref={nameField} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Name" aria-label="Name" maxLength={80} disabled={busy} data-people-name="" />
          {text && <PhoneField digits={digits} onChange={setDigits} disabled={busy} />}
        </div>
        <div>
          <p className="mb-1.5 text-xs text-muted-foreground">How they reach {agentName}</p>
          <ChannelPicker value={channels} onChange={setChannels} reach={reach} disabled={busy} />
        </div>
        {agent && (
          <div>
            <div className="mb-1.5 flex items-center gap-1">
              <p className="mr-auto text-xs text-muted-foreground">Whose agent</p>
              {(
                [
                  ['teammate', 'In this workspace'],
                  ['email', 'By email'],
                  ['link', 'Connect link'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={by === id}
                  onClick={() => setBy(id)}
                  disabled={busy}
                  className={cn(TEXT_BUTTON, by === id ? 'bg-muted' : 'text-muted-foreground')}
                  data-people-agent-by={id}
                >
                  {label}
                </button>
              ))}
            </div>
            {by === 'teammate' && <TeammatePicker candidates={candidates} value={peer?.userId ?? null} onChange={pickPeer} disabled={busy} />}
            {by === 'email' && (
              <>
                <Input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                  inputMode="email"
                  placeholder="The email they sign in to Dial8 with"
                  aria-label="Their email"
                  disabled={busy}
                  data-people-email=""
                />
                <p className="mt-1.5 text-xs text-muted-foreground">They get an email to accept, and can join Dial8 from it if they aren&apos;t on it yet.</p>
              </>
            )}
            {by === 'link' && (
              <p className="rounded-lg border px-3 py-2 text-xs text-muted-foreground" data-people-link-hint="">
                You get a link to send them yourself. Whoever opens it first gets the request, for 7 days.
              </p>
            )}
          </div>
        )}
        <PresetPicker value={preset} onChange={pickPreset} name={agentName} disabled={busy} />
        <button
          type="button"
          onClick={() => setChoosing((v) => !v)}
          aria-expanded={choosing}
          className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          data-people-choose=""
        >
          Choose what they can do
          <ChevronDown aria-hidden className={cn('size-3.5 transition-transform', choosing && 'rotate-180')} />
        </button>
        {choosing && <GuestToolPermissions picks={picks} onChange={setPicks} disabled={busy} />}
        {impossible && <ErrorLine>Not a valid US or Canadian number.</ErrorLine>}
        {error && <ErrorLine>{error}</ErrorLine>}
        <div className="flex justify-end">
          <Button type="submit" disabled={!ready} className={PRIMARY} data-people-create="">
            {busy ? (
              <Loader2 aria-label="Creating" className="animate-spin motion-reduce:animate-none" />
            ) : agent && others.length === 0 ? (
              by === 'link' ? 'Make link' : 'Send request'
            ) : (
              'Create invite'
            )}
          </Button>
        </div>
      </form>
    </Section>
  )
}

/** Their agent asked by email ("Request sent", whoever it is) or by a connect link, shown once to copy. */
function SentCard({ linked, onDone }: { linked: Linked; onDone: () => void }) {
  const first = linked.displayName.split(/\s+/)[0]
  return (
    <Section
      icon={<Link2 aria-hidden className="size-3.5 text-muted-foreground" />}
      title={linked.url ? `Send ${first} this link` : 'Request sent'}
      action={
        <Button variant="ghost" size="icon" className="size-7 shadow-none" onClick={onDone} aria-label="Done">
          <X />
        </Button>
      }
      data-people-sent={linked.url ? 'link' : 'email'}
    >
      {linked.url ? (
        <>
          <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm" data-people-connect-url="">
              {linked.url}
            </span>
            <CopyButton value={linked.url} label="Copy the connect link" />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Works once, for 7 days. Whoever opens it first gets the request, and your agents talk once they accept.</p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          We emailed {linked.email}. When {first} accepts, your agents can talk.
        </p>
      )}
    </Section>
  )
}

/**
 * The invite, shown once, for each channel they still have to join on: the
 * QR code their phone scans and the text it sends, and what they DM the Dial8
 * app on Slack. One code works on each.
 */
function InviteCard({
  guest,
  invite,
  agentName,
  slackTeam,
  onDone,
}: {
  guest: GuestView
  invite: GuestInvite
  agentName: string
  slackTeam: string | null
  onDone: () => void
}) {
  const first = guest.displayName.split(/\s+/)[0]
  const number = invite.dial8Number
  const shown = number ? formatE164ForDisplay(number) : null
  const owed = guest.state === 'active' ? guest.unbound : guest.channels
  const text = owed.includes('sms')
  const slack = owed.includes('slack')
  const textMessage = shown ? `Text "${invite.text}" to ${shown} to reach ${agentName}.` : invite.text
  const slackWhere = slackTeam ? `the Dial8 app in ${slackTeam}` : 'the Dial8 app'
  const slackMessage = `On Slack, send ${slackWhere} a DM: "${invite.text}" to reach ${agentName}.`
  return (
    <Section
      icon={<MessageSquareText aria-hidden className="size-3.5 text-muted-foreground" />}
      title={`Send ${first} this invite`}
      action={
        <Button variant="ghost" size="icon" className="size-7 shadow-none" onClick={onDone} aria-label="Done">
          <X />
        </Button>
      }
      data-people-invite={guest.id}
    >
      <div className="space-y-3">
        {text && (
          <div data-people-invite-channel="sms">
            <p className="text-sm text-muted-foreground">
              When {first} texts &ldquo;{invite.text}&rdquo; to {shown ?? 'the Dial8 number'}, {agentName} answers. It has to come from {first}&apos;s number.
            </p>
            <div className="mt-3 flex items-center gap-4">
              {number && (
                <div className="shrink-0 rounded-xl border bg-white p-2">
                  <QrCode value={smsQrPayload(number, invite.text)} size={96} label={`QR code: ${first} texts ${agentName}`} />
                </div>
              )}
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm tabular-nums" data-people-invite-text="">
                    {invite.text}
                  </span>
                  <CopyButton value={textMessage} label="Copy the text invite" />
                </div>
                <p className="text-xs text-muted-foreground">Scan it with {first}&apos;s phone, or copy the invite and send it however you usually talk.</p>
              </div>
            </div>
          </div>
        )}
        {slack && (
          <div className={cn(text && 'border-t pt-3')} data-people-invite-channel="slack">
            <p className="text-sm text-muted-foreground">
              On Slack, {first} sends {slackWhere} a DM with the same words, and {agentName} answers there.
            </p>
            <div className="mt-2 flex items-center gap-2 rounded-lg border px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm tabular-nums">{invite.text}</span>
              <CopyButton value={slackMessage} label="Copy the Slack invite" />
            </div>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{text && slack ? 'Works once on each, for 7 days.' : 'Works once, for 7 days.'}</p>
      </div>
    </Section>
  )
}

/** "Let people ask": your request code, and its switch. */
function LetPeopleAsk({
  state,
  dial8Number,
  name,
  onChange,
}: {
  state: { code: string; open: boolean }
  dial8Number: string | null
  name: string
  onChange: (state: { code: string; open: boolean }) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toggle = async (open: boolean) => {
    setBusy(true)
    setError(null)
    const result = await send<{ code: string; open: boolean }>('/api/account/agent-guests/request-code', 'PATCH', { open })
    setBusy(false)
    if (!result.ok) return setError(result.error)
    onChange(result.data)
  }
  const join = `JOIN ${state.code}`
  const shown = dial8Number ? formatE164ForDisplay(dial8Number) : null
  return (
    <section className="rounded-xl border p-3" data-people-ask-open={state.open ? 'on' : 'off'}>
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Let people ask</span>
          <span className="block text-xs text-muted-foreground">
            {state.open
              ? `Anyone who texts “${join}”${shown ? ` to ${shown}` : ''} shows up above for you to allow or ignore.`
              : `Off. Turn it on to give people a code to ask you for access to ${name}.`}
          </span>
        </span>
        <Switch checked={state.open} onCheckedChange={toggle} disabled={busy} aria-label="Let people ask" />
      </div>
      {state.open && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium tabular-nums" data-people-request-code="">
            {join}
          </span>
          <CopyButton value={shown ? `Text "${join} <your name>" to ${shown} to ask for access to ${name}.` : join} label="Copy how to ask" />
        </div>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
    </section>
  )
}

/**
 * One person's page: where they reach it (Their agent with the link's state,
 * and Disconnect), their preset, what their agent can do, your notes, their
 * calendar emails, a new invite, Remove.
 */
function PersonPage({
  guest,
  link,
  candidates,
  agentName,
  reach,
  onLinksChanged,
  onBack,
  onChanged,
  onRemoved,
  onInvite,
}: {
  guest: GuestView
  link?: LinkView
  candidates: LinkCandidate[]
  agentName: string
  reach: Reach
  onLinksChanged: () => Promise<void>
  onBack: () => void
  onChanged: (g: GuestView) => void
  onRemoved: () => void
  onInvite: (g: GuestView, invite: GuestInvite) => void
}) {
  const actions = useGuestActions(guest, { onChanged, onRemoved, onInvite, link, onLinksChanged })
  const [confirming, setConfirming] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [notes, setNotes] = useState(guest.notes ?? '')
  const [emails, setEmails] = useState((guest.calendarEmails ?? []).join(', '))
  const [emailsError, setEmailsError] = useState<string | null>(null)
  const first = guest.displayName.split(/\s+/)[0]
  // A pick that needs more first, held here: their number for Text, which teammate for Their agent.
  const [draft, setDraft] = useState<GuestChannelId[] | null>(null)
  const [digits, setDigits] = useState('')
  const [peer, setPeer] = useState<LinkCandidate | null>(null)
  const [linking, setLinking] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const wantsNumber = draft !== null && draft.includes('sms') && guest.masked === null
  const wantsAgent = draft !== null && draft.includes('dial8') && !guest.channels.includes('dial8')
  const pickChannels = (channels: GuestChannelId[]) => {
    const agent = channels.includes('dial8') && !guest.channels.includes('dial8')
    if (agent || (channels.includes('sms') && guest.masked === null)) return setDraft(channels)
    setDraft(null)
    void actions.patch({ channels })
  }
  const saveDraft = async () => {
    if (!draft || (wantsNumber && !isCompleteNanp(digits)) || (wantsAgent && !peer)) return
    const rest = draft.filter((c) => c !== 'dial8')
    const restNow = guest.channels.filter((c) => c !== 'dial8')
    if (wantsNumber || rest.join() !== restNow.join()) {
      if (rest.length > 0 || !wantsAgent) await actions.patch({ channels: rest, ...(wantsNumber ? { phone: nanpE164(digits) } : {}) })
    }
    if (!wantsAgent || !peer) return setDraft(null)
    setLinking(true)
    setLinkError(null)
    const asked = await send<{ link: LinkView | null }>('/api/account/agent-links', 'POST', {
      guestId: guest.id,
      peerUserId: peer.userId,
      displayName: guest.displayName,
      preset: guest.preset === 'custom' ? 'household' : guest.preset,
    })
    setLinking(false)
    if (!asked.ok) return setLinkError(asked.error)
    setDraft(null)
    await onLinksChanged()
  }
  // Saved: their number is on file now.
  useEffect(() => {
    if (guest.masked !== null && !wantsAgent) setDraft(null)
    // Only when the number lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guest.masked])
  const saveNotes = () => {
    const next = notes.trim()
    if (next === (guest.notes ?? '')) return
    void actions.patch({ notes: next || null })
  }
  // Saved as the store keeps them (lower case, each once): the field shows that list again.
  const savedEmails = (guest.calendarEmails ?? []).join(', ')
  useEffect(() => {
    setEmails(savedEmails)
    setEmailsError(null)
  }, [savedEmails])
  // Checked here first, so a typo is named beside the field, not only at the top of the page.
  const saveEmails = () => {
    const next = cleanCalendarEmails(splitCalendarEmails(emails))
    if (!next) return setEmailsError('Enter up to 5 email addresses, separated by commas.')
    setEmailsError(null)
    if (next.join(', ') === savedEmails) return setEmails(savedEmails)
    void actions.patch({ calendarEmails: next })
  }

  return (
    <div className="space-y-4" data-people-page={guest.id}>
      <button type="button" onClick={onBack} className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground" data-people-back="">
        <ArrowLeft aria-hidden className="size-3.5" />
        People
      </button>
      <div className="flex items-center gap-3">
        <Initials name={guest.displayName} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {agentName} for {guest.displayName}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{statusOf(guest, undefined, link)}</span>
        </span>
        {(actions.busy || linking) && <Loader2 aria-label="Saving" className="size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none" />}
      </div>
      {actions.error && <ErrorLine>{actions.error}</ErrorLine>}

      <div data-people-channels="">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">How {first} reaches {agentName}</h4>
        <div className="mt-2">
          <ChannelPicker
            value={draft ?? guest.channels}
            onChange={pickChannels}
            reach={reach}
            disabled={actions.busy || linking}
            fixed={guest.channels.includes('dial8') ? ['dial8'] : []}
          />
        </div>
        {wantsAgent && (
          <div className="mt-2">
            <p className="mb-1.5 text-xs text-muted-foreground">Whose agent</p>
            <TeammatePicker candidates={candidates} value={peer?.userId ?? null} onChange={setPeer} disabled={linking} />
          </div>
        )}
        {draft && (
          <div className="mt-2 flex items-center gap-2">
            <div className="min-w-0 flex-1">{wantsNumber && <PhoneField digits={digits} onChange={setDigits} disabled={actions.busy || linking} />}</div>
            <Button variant="ghost" size="sm" className="shadow-none" onClick={() => setDraft(null)} disabled={actions.busy || linking}>
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void saveDraft()}
              disabled={actions.busy || linking || (wantsNumber && !isCompleteNanp(digits)) || (wantsAgent && !peer)}
              data-people-save-channels=""
            >
              {wantsAgent ? 'Send request' : 'Add Text'}
            </Button>
          </div>
        )}
        {linkError && <ErrorLine>{linkError}</ErrorLine>}
        {link && (
          <div className="mt-2 flex items-center gap-3 rounded-lg border px-3 py-2" data-people-link={link.state}>
            <span className="min-w-0 flex-1">
              {link.state === 'active' ? (
                <>
                  <span className="block text-sm">
                    {agentName} can ask {first}&apos;s agent
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {link.theirHalf?.summary ? `${first} chose: ${link.theirHalf.summary}.` : `${first} hasn’t let it ask anything yet.`} You can&apos;t change this side.
                  </span>
                </>
              ) : (
                <>
                  <span className="block text-sm">Waiting for {first} to accept</span>
                  <span className="block text-xs text-muted-foreground">
                    Nothing passes between your agents until they do{link.expiresAt ? `. The request ends ${new Date(link.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}.
                  </span>
                </>
              )}
            </span>
            <button type="button" onClick={() => setDisconnecting(true)} disabled={actions.busy} className={cn(TEXT_BUTTON, 'text-muted-foreground')} data-people-disconnect="">
              {link.state === 'active' ? 'Disconnect' : 'Withdraw'}
            </button>
          </div>
        )}
        {guest.state === 'active' && guest.unbound.length > 0 && (
          <p className="mt-1.5 text-xs text-muted-foreground" data-people-unbound="">
            {first} isn&apos;t on {channelsLabel(guest.unbound)} yet. Send them a new invite link to join there.
          </p>
        )}
      </div>

      <div>
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Start from</h4>
        <div className="mt-2">
          <PresetPicker value={guest.preset} onChange={(preset) => preset !== guest.preset && actions.setPreset(preset)} name={agentName} disabled={actions.busy} />
        </div>
        {guest.preset === 'custom' && <p className="mt-1.5 text-xs text-muted-foreground">Adjusted for {first}. Pick one to start over from it.</p>}
      </div>

      <div>
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">What {agentName} can do for {first}</h4>
        <div className="mt-2">
          <GuestToolPermissions picks={guest} onChange={({ tools, askTools, askBefore }) => actions.patch({ tools, askTools, askBefore })} disabled={actions.busy} />
        </div>
      </div>

      <div>
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Notes for {first}&apos;s {agentName}</h4>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={saveNotes}
          maxLength={2000}
          rows={3}
          placeholder={`Anything it should know, like “${first} is my wife” or “never share my work calendar”.`}
          className="mt-2 resize-none"
          disabled={actions.busy}
          data-people-notes=""
        />
        <p className="mt-1.5 text-xs text-muted-foreground">The only thing about you it reads beyond what you switched on.</p>
      </div>

      <div>
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Calendar emails</h4>
        <Input
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          onBlur={saveEmails}
          placeholder={`${first.toLowerCase()}@example.com`}
          aria-label={`${first}'s calendar emails`}
          aria-invalid={emailsError ? true : undefined}
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          className={cn('mt-2', emailsError && 'border-destructive')}
          disabled={actions.busy}
          data-people-calendar-emails=""
        />
        {emailsError ? (
          <ErrorLine>{emailsError}</ErrorLine>
        ) : (
          <p className="mt-1.5 text-xs text-muted-foreground">
            Invites from these count as your own plans: no meeting prep when only {first} is on it, and your look-ahead texts them.
            {guest.state !== 'active' ? ` Starts once ${first} joins.` : ''}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        {invitable(guest) && (
          <Button variant="outline" size="sm" onClick={() => actions.newInvite()} disabled={actions.busy} data-people-new-invite="">
            New invite link
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive shadow-none hover:text-destructive"
          onClick={() => setConfirming(true)}
          disabled={actions.busy}
          data-people-remove=""
        >
          Remove access
        </Button>
      </div>
      <RemoveConfirm guest={guest} open={confirming} onOpenChange={setConfirming} busy={actions.busy} onConfirm={() => void actions.remove().then(() => setConfirming(false))} />
      <ConfirmDialog
        open={disconnecting}
        onOpenChange={setDisconnecting}
        title={link?.state === 'active' ? `Disconnect ${first}’s agent?` : `Withdraw the request to ${first}?`}
        description={`Your agents stop talking, starting now, for both of you.${guest.channels.some((c) => c !== 'dial8') ? ` ${first} can still reach ${agentName} on ${channelsLabel(guest.channels.filter((c) => c !== 'dial8'))}.` : ''}`}
        confirmLabel={link?.state === 'active' ? 'Disconnect' : 'Withdraw'}
        busy={actions.busy}
        onConfirm={() => void actions.disconnect().then(() => setDisconnecting(false))}
      />
    </div>
  )
}

/**
 * Review an agent asking to talk to yours: what their agent may ask yours
 * (a preset, then the same Tool permissions as a person), then Let them talk.
 * Nothing passes until you do.
 */
function ReviewLink({ link, agentName, onBack, onAccepted }: { link: LinkView; agentName: string; onBack: () => void; onAccepted: (link: LinkView) => void | Promise<void> }) {
  const [preset, setPreset] = useState<GuestPresetId>('colleague')
  const [picks, setPicks] = useState<GuestPicks>(() => presetSettings('colleague'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Which of your workspaces' agents answers: asked only when you have more than one (decision 4).
  const [workspaces, setWorkspaces] = useState<AnswerWorkspace[] | null>(null)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void read<{ workspaces: AnswerWorkspace[] }>('/api/account/agent-links/answer-workspaces').then((r) => {
      if (!cancelled) setWorkspaces(r?.workspaces ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [])
  const choosingWorkspace = (workspaces?.length ?? 0) > 1
  const first = link.peer.name.split(/\s+/)[0]
  const pickPreset = (id: GuestPresetId) => {
    setPreset(id)
    setPicks(presetSettings(id))
  }
  const accept = async () => {
    setBusy(true)
    setError(null)
    const result = await send<{ link: LinkView | null }>(`/api/account/agent-links/${link.id}/accept`, 'POST', {
      preset,
      tools: picks.tools,
      askTools: picks.askTools,
      askBefore: picks.askBefore,
      ...(choosingWorkspace && workspaceId ? { workspaceId } : {}),
    })
    setBusy(false)
    if (!result.ok) return setError(result.error)
    await onAccepted(result.data.link ?? link)
  }
  return (
    <div className="space-y-4" data-people-review={link.id}>
      <button type="button" onClick={onBack} className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground" data-people-back="">
        <ArrowLeft aria-hidden className="size-3.5" />
        People
      </button>
      <div className="flex items-center gap-3">
        <Initials name={link.peer.name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{link.peer.name}&apos;s agent wants to talk to {agentName}</span>
          <span className="block truncate text-xs text-muted-foreground">{linkLine(link)}</span>
        </span>
      </div>
      {choosingWorkspace && (
        <div>
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Which agent answers</h4>
          <ul role="radiogroup" aria-label="Which agent answers" className="mt-2 divide-y rounded-lg border" data-people-answer-workspaces="">
            {workspaces!.map((w) => {
              const off = link.outside && !w.outsideAllowed
              return (
                <li key={w.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={workspaceId === w.id}
                    disabled={busy || off}
                    onClick={() => setWorkspaceId(w.id)}
                    data-people-answer-workspace={w.id}
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50',
                      workspaceId === w.id ? 'bg-muted/40' : 'hover:bg-muted/30',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">Your agent in {w.name}</span>
                      {off && <span className="block text-xs text-muted-foreground">Your workspace admin has turned off links outside this workspace</span>}
                    </span>
                    {workspaceId === w.id && <Check aria-hidden className="size-3.5 shrink-0 text-foreground" />}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
      <div>
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Start from</h4>
        <div className="mt-2">
          <PresetPicker value={preset} onChange={pickPreset} name={agentName} disabled={busy} />
        </div>
      </div>
      <div>
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          What {first}&apos;s agent can ask {agentName}
        </h4>
        <div className="mt-2">
          <GuestToolPermissions picks={picks} onChange={setPicks} disabled={busy} />
        </div>
      </div>
      {error && <ErrorLine>{error}</ErrorLine>}
      <div className="flex items-center justify-end gap-2 border-t pt-4">
        <Button variant="ghost" size="sm" className="shadow-none" onClick={onBack} disabled={busy}>
          Not now
        </Button>
        <Button onClick={() => void accept()} disabled={busy || workspaces === null || (choosingWorkspace && !workspaceId)} className={PRIMARY} data-people-accept="">
          {busy ? <Loader2 aria-label="Saving" className="animate-spin motion-reduce:animate-none" /> : 'Let them talk'}
        </Button>
      </div>
    </div>
  )
}
