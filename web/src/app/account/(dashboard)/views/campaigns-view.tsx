'use client'

/**
 * Campaigns — the tab root for the 'campaigns' AccountView.
 *
 * Deliberately the SMALLEST surface that makes the anchor real: a list of the
 * workspace's campaigns and a panel to create or edit one. No analytics, no
 * calendar, no per-channel metrics — a campaign exists here so knowledge can
 * hang off it.
 *
 * A campaign that SENDS (roadmap D2) shows who it reaches (its audience in a
 * line), its sequence, and its sent / replied / opted-out counts; the editor's
 * Outreach section sets the audience, the sequence and whether new matches
 * join each week. Nothing here sends: the agent asks to launch it, and the
 * person's yes on that card (or by text) is what sends.
 *
 * It is NOT wired into the shared views system (UnifiedViewLayout /
 * `ViewEntityType`) the way Sequences and Flows are. That would mean entries in
 * a dozen `Record<ViewEntityType, …>` maps, board grouping, filter fields and
 * a query-engine branch — the full saved-views apparatus, for an entity with
 * eight columns. This owns its own fetch against /api/account/campaigns
 * instead; promoting it later is additive.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Megaphone, Plus, Repeat } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  CAMPAIGN_STATUSES,
  CAMPAIGN_STATUS_LABELS,
  describeAudience,
  type Campaign,
  type CampaignAudience,
  type CampaignStatus,
} from '@/lib/campaigns/shape'
import { ViewHeader } from './view-header'

const NEW_CAMPAIGN_LABEL = 'New campaign'

/** Status → the dot colour that carries the state at a glance. */
const STATUS_DOT: Record<CampaignStatus, string> = {
  planned: 'bg-muted-foreground/50',
  active: 'bg-emerald-500',
  paused: 'bg-amber-500',
  completed: 'bg-blue-500',
  archived: 'bg-muted-foreground/30',
}

export function CampaignsView({ onCount }: { onCount?: (count: number) => void } = {}) {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null)
  // How many there are, for a chat card's header (pages in the chat).
  const onCountRef = useRef(onCount)
  onCountRef.current = onCount
  useEffect(() => {
    if (campaigns) onCountRef.current?.(campaigns.length)
  }, [campaigns])
  const [error, setError] = useState<string | null>(null)
  // The campaign the editor is on: a row to edit, '__new__' to create, or null.
  const [editing, setEditing] = useState<Campaign | '__new__' | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/campaigns')
      if (!res.ok) throw new Error('Could not load campaigns')
      const json = await res.json()
      setCampaigns(Array.isArray(json.campaigns) ? json.campaigns : [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load campaigns')
      setCampaigns([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleSaved = useCallback(
    (saved: Campaign) => {
      setEditing(null)
      // Replace in place when it already exists so an edit doesn't reorder the
      // list under the user's cursor; a create goes to the top (the list is
      // most-recently-updated first).
      setCampaigns((prev) => {
        if (!prev) return [saved]
        const idx = prev.findIndex((c) => c.id === saved.id)
        if (idx === -1) return [saved, ...prev]
        const next = [...prev]
        next[idx] = saved
        return next
      })
    },
    [],
  )

  return (
    <div className="flex h-full flex-col">
      <ViewHeader
        title="Campaigns"
        actions={
          <Button size="sm" onClick={() => setEditing('__new__')}>
            <Plus className="h-3.5 w-3.5" />
            {NEW_CAMPAIGN_LABEL}
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {campaigns === null ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="py-10 text-center text-sm text-destructive">{error}</p>
        ) : campaigns.length === 0 ? (
          <EmptyState onCreate={() => setEditing('__new__')} />
        ) : (
          <ul className="divide-y divide-border">
            {campaigns.map((campaign) => (
              <CampaignRow
                key={campaign.id}
                campaign={campaign}
                onOpen={() => setEditing(campaign)}
              />
            ))}
          </ul>
        )}
      </div>

      {editing !== null && (
        <CampaignEditor
          campaign={editing === '__new__' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <Megaphone className="h-7 w-7 text-muted-foreground/60" />
      <div>
        <p className="text-sm font-medium text-foreground">No campaigns yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          A campaign is what your marketing meetings, notes and decisions hang off.
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={onCreate}>
        <Plus className="h-3.5 w-3.5" />
        {NEW_CAMPAIGN_LABEL}
      </Button>
    </div>
  )
}

function CampaignRow({
  campaign,
  onOpen,
}: {
  campaign: Campaign
  onOpen: () => void
}) {
  const dates = useMemo(() => formatWindow(campaign.starts_on, campaign.ends_on), [
    campaign.starts_on,
    campaign.ends_on,
  ])

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-muted/40"
      >
        <span
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[campaign.status])}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{campaign.name}</span>
            {campaign.rolling && campaign.sequence_id && (
              <Repeat className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Adds new matches weekly" />
            )}
          </span>
          {campaign.sequence_id && campaign.audience ? (
            <span className="block truncate text-xs text-muted-foreground">
              {describeAudience(campaign.audience)}
            </span>
          ) : (
            campaign.objective && (
              <span className="block truncate text-xs text-muted-foreground">
                {campaign.objective}
              </span>
            )
          )}
        </span>
        {hasSent(campaign) && (
          <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:block">
            {campaign.counts.sent} sent · {campaign.counts.replied} replied · {campaign.counts.opted_out} opted out
          </span>
        )}
        {!hasSent(campaign) && campaign.channels.length > 0 && (
          <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:block">
            {campaign.channels.join(', ')}
          </span>
        )}
        {dates && (
          <span className="hidden shrink-0 text-xs text-muted-foreground md:block">{dates}</span>
        )}
        <span className="shrink-0 text-xs text-muted-foreground">
          {CAMPAIGN_STATUS_LABELS[campaign.status]}
        </span>
      </button>
    </li>
  )
}

/** "Mar 1 – Apr 15", one-sided, or null when neither date is set. */
function formatWindow(startsOn: string | null, endsOn: string | null): string | null {
  const fmt = (iso: string) => {
    // Parse the calendar date as-is: `new Date('2026-03-01')` is UTC midnight,
    // which renders as the PREVIOUS day west of Greenwich.
    const [y, m, d] = iso.split('-').map(Number)
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    })
  }
  if (startsOn && endsOn) return `${fmt(startsOn)} – ${fmt(endsOn)}`
  if (startsOn) return `From ${fmt(startsOn)}`
  if (endsOn) return `Until ${fmt(endsOn)}`
  return null
}

function CampaignEditor({
  campaign,
  onClose,
  onSaved,
}: {
  /** null = create. */
  campaign: Campaign | null
  onClose: () => void
  onSaved: (campaign: Campaign) => void
}) {
  const [name, setName] = useState(campaign?.name ?? '')
  const [objective, setObjective] = useState(campaign?.objective ?? '')
  const [description, setDescription] = useState(campaign?.description ?? '')
  const [status, setStatus] = useState<CampaignStatus>(campaign?.status ?? 'planned')
  const [channels, setChannels] = useState((campaign?.channels ?? []).join(', '))
  const [startsOn, setStartsOn] = useState(campaign?.starts_on ?? '')
  const [endsOn, setEndsOn] = useState(campaign?.ends_on ?? '')
  const [audienceType, setAudienceType] = useState<AudienceChoice>(audienceChoiceOf(campaign?.audience ?? null))
  const [quietMonths, setQuietMonths] = useState(quietMonthsOf(campaign?.audience ?? null))
  const [sequenceId, setSequenceId] = useState<string>(campaign?.sequence_id ?? NO_SEQUENCE)
  const [rolling, setRolling] = useState(campaign?.rolling ?? false)
  const [sequences, setSequences] = useState<Array<{ id: string; name: string }> | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/account/sequences')
      .then((res) => (res.ok ? res.json() : { sequences: [] }))
      .then((json) => {
        if (cancelled) return
        const rows = Array.isArray(json.sequences) ? json.sequences : []
        setSequences(
          rows
            .filter((s: { status?: string }) => s.status !== 'archived')
            .map((s: { id: string; name: string }) => ({ id: s.id, name: s.name })),
        )
      })
      .catch(() => !cancelled && setSequences([]))
    return () => {
      cancelled = true
    }
  }, [])

  // An audience this editor can't express (tags, chosen contacts) is kept as is.
  const audienceEditable = isEditableAudience(campaign?.audience ?? null)

  const save = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    setError(null)
    const body = {
      name: name.trim(),
      objective,
      description,
      status,
      channels: channels
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean),
      starts_on: startsOn || null,
      ends_on: endsOn || null,
      sequence_id: sequenceId === NO_SEQUENCE ? null : sequenceId,
      rolling,
      ...(audienceEditable ? { audience: buildAudience(audienceType, quietMonths) } : {}),
    }
    try {
      const res = await fetch(
        campaign ? `/api/account/campaigns/${campaign.id}` : '/api/account/campaigns',
        {
          method: campaign ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Could not save campaign')
      onSaved(json.campaign as Campaign)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save campaign')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{campaign ? 'Edit campaign' : NEW_CAMPAIGN_LABEL}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Spring product launch"
              autoFocus
            />
          </Field>

          <Field label="Objective" hint="What this campaign is for, in one line.">
            <Input
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="Drive 200 demo requests from mid-market ops teams"
            />
          </Field>

          <Field label="Notes">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Plan, audience, anything worth remembering."
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Status">
              <Select value={status} onValueChange={(v) => setStatus(v as CampaignStatus)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CAMPAIGN_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {CAMPAIGN_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Channels" hint="Comma separated.">
              <Input
                value={channels}
                onChange={(e) => setChannels(e.target.value)}
                placeholder="email, linkedin"
              />
            </Field>

            <Field label="Starts">
              <Input
                type="date"
                value={startsOn}
                onChange={(e) => setStartsOn(e.target.value)}
              />
            </Field>

            <Field label="Ends">
              <Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
            </Field>
          </div>

          <div className="space-y-3 border-t border-border pt-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs font-medium text-foreground">Outreach</span>
              {campaign && hasSent(campaign) && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {campaign.counts.sent} sent · {campaign.counts.replied} replied · {campaign.counts.opted_out} opted out
                </span>
              )}
            </div>

            {audienceEditable ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Who">
                  <Select value={audienceType} onValueChange={(v) => setAudienceType(v as AudienceChoice)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AUDIENCE_CHOICES.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Not in touch for" hint="Months. Empty: anyone.">
                  <Input
                    type="number"
                    min={1}
                    max={36}
                    inputMode="numeric"
                    value={quietMonths}
                    onChange={(e) => setQuietMonths(e.target.value)}
                    placeholder="6"
                    disabled={audienceType === NO_AUDIENCE}
                  />
                </Field>
              </div>
            ) : (
              <Field label="Who">
                <p className="text-sm text-foreground">{describeAudience(campaign?.audience ?? null)}</p>
              </Field>
            )}

            <Field label="Sequence" hint="The emails it sends.">
              <Select value={sequenceId} onValueChange={setSequenceId}>
                <SelectTrigger>
                  <SelectValue placeholder={sequences === null ? 'Loading…' : 'None'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SEQUENCE}>None</SelectItem>
                  {(sequences ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <label className="flex items-center justify-between gap-3">
              <span className="text-sm text-foreground">Add new matches every week</span>
              <Switch checked={rolling} onCheckedChange={setRolling} />
            </label>

            <p className="text-xs text-muted-foreground/80">
              Nothing sends from here. Ask Native Intelligence to launch it: you approve every email and
              recipient first, in the app or by text.
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!name.trim() || saving}>
            {saving ? 'Saving…' : campaign ? 'Save' : 'Create campaign'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Whether the campaign has reached anyone yet: its counts show only then (an unsent one shows none). */
function hasSent(campaign: Campaign): campaign is Campaign & { counts: NonNullable<Campaign['counts']> } {
  return (campaign.counts?.recipients ?? 0) > 0
}

const NO_SEQUENCE = '__none__'
const NO_AUDIENCE = 'none'

type AudienceChoice = 'customer' | 'lead' | 'partner' | 'contact' | typeof NO_AUDIENCE

const AUDIENCE_CHOICES: Array<{ value: AudienceChoice; label: string }> = [
  { value: 'customer', label: 'Customers' },
  { value: 'lead', label: 'Leads' },
  { value: 'partner', label: 'Partners' },
  { value: 'contact', label: 'Other contacts' },
  { value: NO_AUDIENCE, label: 'Nobody yet' },
]

/** Whether this editor's two fields (one type, months quiet) can express the audience. */
function isEditableAudience(audience: CampaignAudience | null): boolean {
  if (!audience) return true
  return (
    !audience.tags_any?.length &&
    !audience.contact_ids?.length &&
    !audience.include_never_contacted &&
    (audience.relationship_types?.length ?? 1) === 1
  )
}

function audienceChoiceOf(audience: CampaignAudience | null): AudienceChoice {
  if (!audience) return NO_AUDIENCE
  const type = audience.relationship_types?.[0] ?? 'customer'
  return type === 'vendor' ? 'contact' : type
}

function quietMonthsOf(audience: CampaignAudience | null): string {
  const days = audience?.last_contacted_more_than_days
  return days ? String(Math.max(1, Math.round(days / 30))) : ''
}

/** The two fields as an audience (null: nobody). */
function buildAudience(choice: AudienceChoice, months: string): CampaignAudience | null {
  if (choice === NO_AUDIENCE) return null
  const n = Number.parseInt(months, 10)
  return {
    relationship_types: [choice],
    ...(Number.isInteger(n) && n >= 1 && n <= 36 ? { last_contacted_more_than_days: n * 30 } : {}),
  }
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground/70">{hint}</span>}
    </label>
  )
}
