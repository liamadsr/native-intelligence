'use client'

/**
 * Settings → Autonomy (plan Part 5 row 9, follow-up §B.4 PR 5). Agents make a
 * first pass on drafting work by default (Liam, 2026-10-17: opinionated
 * platform, no configuration fatigue), so there is no mode to choose: the page
 * is the workspace's kill switch (on = 'attempt', off = 'off'), and while it is
 * on, the limits on unattended work, when a role pauses itself, chat
 * delegation, and each teammate's role and autonomy. Switched off, the limits
 * mean nothing and are not shown. Everything reads and writes
 * `/api/account/workspace/agent-autonomy` (owner/admin writes; any member reads).
 */
import { useCallback, useEffect, useState } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import { toast } from 'sonner'
import { PauseCircle, PlayCircle } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { DELEGABLE_WORK_ROLES, WORK_ROLES, WORK_ROLE_LABELS, type WorkRole } from '@/lib/work/roles'
import type { AgentAutonomyMode, AgentAutonomyPolicy } from '@/lib/work/agent-autonomy-policy'
import { teammateAutonomyLine } from '@/lib/work/autonomy-line'

export const AGENT_AUTONOMY_URL = '/api/account/workspace/agent-autonomy'

interface Teammate {
  id: string
  name: string
  avatar_url: string | null
  role: WorkRole | null
  autonomy: string | null
  allowed_side_effects: string[]
}

interface RoleState {
  role: WorkRole
  attemptable: boolean
  default_teammate_id: string | null
  breaker: { paused: boolean; window: number } | null
  resumed_at: string | null
}

interface Loaded {
  workspace_id: string
  policy: AgentAutonomyPolicy
  can_edit: boolean
  teammates: Teammate[]
  roles: RoleState[]
}

const NUMBER_FIELDS: Array<{
  key: 'max_chat_delegations_per_day' | 'max_chat_delegations_per_conversation' | 'max_attempts_per_capture' | 'max_attempts_per_day' | 'role_breaker_window' | 'role_breaker_quiet_days'
  group: 'limits' | 'pausing' | 'chat'
  label: string
  hint: string
  max: number
}> = [
  { key: 'max_chat_delegations_per_day', group: 'chat', label: 'Delegations per day', hint: 'Across the workspace, per UTC day.', max: 500 },
  { key: 'max_chat_delegations_per_conversation', group: 'chat', label: 'Helpers per conversation', hint: 'How many helpers one chat can have working at once.', max: 500 },
  { key: 'max_attempts_per_capture', group: 'limits', label: 'First passes per meeting', hint: 'How many one meeting can start.', max: 20 },
  { key: 'max_attempts_per_day', group: 'limits', label: 'First passes per day', hint: 'Across the workspace, per UTC day.', max: 500 },
  {
    key: 'role_breaker_window',
    group: 'pausing',
    label: 'Pause a role after this many dismissed in a row',
    hint: 'When a role’s last first passes were all dismissed, it stops attempting. 0 never pauses.',
    max: 20,
  },
  {
    key: 'role_breaker_quiet_days',
    group: 'pausing',
    label: 'Count first passes from the last',
    hint: 'Days. A paused role tries again once its dismissed first passes are older than this.',
    max: 90,
  },
]

/** A role no teammate holds: the gate creates the role teammates on first need. */
const NO_HOLDER = 'No teammate yet. One is added the first time this role’s work comes up.'

function autonomyLine(t: Teammate | undefined): string {
  if (!t) return NO_HOLDER
  return teammateAutonomyLine(t)
}

export function AutonomySettingsView() {
  const [data, setData] = useState<Loaded | null>(null)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(AGENT_AUTONOMY_URL, { cache: 'no-store' })
      if (!res.ok) throw new Error()
      setData((await res.json()) as Loaded)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const savePolicy = useCallback(
    async (patch: Partial<AgentAutonomyPolicy>) => {
      if (!data) return
      const before = data.policy
      setData({ ...data, policy: { ...data.policy, ...patch } })
      setSaving(true)
      try {
        const res = await fetch(AGENT_AUTONOMY_URL, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ policy: patch }),
        })
        const body = (await res.json().catch(() => ({}))) as { error?: string; seeded?: number; stopped?: string | null }
        if (!res.ok) throw new Error(body.error ?? 'Could not save')
        if (body.seeded) toast(`Added ${body.seeded} role teammate${body.seeded === 1 ? '' : 's'}`)
        if (body.stopped === 'requested') toast('Stopping the first passes already running')
        if (body.stopped === 'failed') toast.error('Switched off, but the running first passes could not be stopped. Stop them from each teammate’s page.')
        // The seed and the breaker change what the roles section shows.
        await load()
      } catch (e) {
        setData((d) => (d ? { ...d, policy: before } : d))
        toast.error(e instanceof Error ? e.message : 'Could not save')
      } finally {
        setSaving(false)
      }
    },
    [data, load],
  )

  const saveTeammate = useCallback(
    async (id: string, patch: { role?: WorkRole | null; autonomy?: AgentAutonomyMode }) => {
      setSaving(true)
      try {
        const res = await fetch(`${AGENT_AUTONOMY_URL}/teammates/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(body.error ?? 'Could not save')
        }
        await load()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not save')
      } finally {
        setSaving(false)
      }
    },
    [load],
  )

  const resume = useCallback(
    async (role: WorkRole) => {
      if (!data) return
      setSaving(true)
      try {
        const res = await fetch(`${AGENT_AUTONOMY_URL}/resume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-workspace-id': data.workspace_id },
          body: JSON.stringify({ role, workspace_id: data.workspace_id }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(body.error ?? 'Could not resume')
        }
        toast(`${WORK_ROLE_LABELS[role]} will attempt again`)
        await load()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not resume')
      } finally {
        setSaving(false)
      }
    },
    [data, load],
  )

  if (failed && !data) {
    return (
      <div className="mx-auto max-w-2xl px-8 py-8 text-sm text-muted-foreground">
        Could not load the autonomy settings.{' '}
        <button type="button" className="underline" onClick={() => void load()}>
          Try again
        </button>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="flex h-full items-center justify-center">
        <ThinkingOrb state="working" size={20} theme="auto" />
      </div>
    )
  }

  const { policy } = data
  const disabled = !data.can_edit || saving
  const byId = new Map(data.teammates.map((t) => [t.id, t]))
  // On is what the gate attempts on: 'attempt' only. A stored 'propose' (from
  // before 354, or a malformed policy, which falls back to it) makes cards
  // with Start, so it shows off; switching on writes 'attempt' over the whole
  // normalized policy, malformed numbers replaced by defaults.
  const on = policy.mode === 'attempt'

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-8">
        <h1 className="text-lg font-semibold">Autonomy</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          When a meeting asks for research, a document or an email, that role’s teammate makes a first pass and leaves it
          in For you to review. A first pass is always a draft: nothing is sent, and nothing on the board
          changes.
        </p>
        {!data.can_edit && (
          <p className="mt-6 rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
            Only workspace admins can change this. The current configuration is shown below.
          </p>
        )}

        <div className="mt-8 space-y-8">
          <section aria-label="Agents work on their own">
            <label className="flex items-center gap-3 rounded-lg border px-4 py-3">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Agents work on their own</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {on
                    ? 'First passes, chat helpers and loops run without anyone pressing Start.'
                    : 'Switched off: the agent starts nothing on its own, and work comes as cards with Start.'}
                </span>
              </span>
              <Switch
                aria-label="Agents work on their own"
                checked={on}
                disabled={disabled}
                onCheckedChange={(next) => void savePolicy({ mode: next ? 'attempt' : 'off' })}
              />
            </label>
          </section>

          {on && (['limits', 'pausing'] as const).map((group) => (
            <section key={group} aria-label={group === 'limits' ? 'Limits' : 'Pausing'}>
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">{group === 'limits' ? 'Limits' : 'Pausing'}</h2>
              <div className="divide-y rounded-lg border">
                {NUMBER_FIELDS.filter((f) => f.group === group).map((f) => (
                  <NumberRow
                    key={f.key}
                    label={f.label}
                    hint={f.hint}
                    max={f.max}
                    suffix={f.key === 'role_breaker_quiet_days' ? 'days' : undefined}
                    value={policy[f.key]}
                    disabled={disabled}
                    onCommit={(v) => void savePolicy({ [f.key]: v })}
                  />
                ))}
                {group === 'limits' && (
                  <ConfidenceRow
                    value={policy.attempt_min_confidence}
                    disabled={disabled}
                    onCommit={(v) => void savePolicy({ attempt_min_confidence: v })}
                  />
                )}
              </div>
            </section>
          ))}

          {on && (
            <section aria-label="Chat delegation">
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">Chat delegation</h2>
              <p className="mb-3 text-xs text-muted-foreground">Chat can ask these teammates to research or draft work you request. Results wait in For you and on the teammate’s page for review.</p>
              <div className="divide-y rounded-lg border">
                {DELEGABLE_WORK_ROLES.map((role) => (
                  <label key={role} className="flex items-center justify-between px-4 py-3 text-sm">
                    {WORK_ROLE_LABELS[role]}
                    <input type="checkbox" aria-label={`Chat can delegate to ${WORK_ROLE_LABELS[role]}`}
                      checked={policy.chat_can_delegate_to?.includes(role) ?? false} disabled={disabled}
                      onChange={(e) => void savePolicy({ chat_can_delegate_to: e.target.checked
                        ? [...(policy.chat_can_delegate_to ?? []), role]
                        : (policy.chat_can_delegate_to ?? []).filter((r) => r !== role) })} />
                  </label>
                ))}
                {NUMBER_FIELDS.filter((f) => f.group === 'chat').map((f) => (
                  <NumberRow key={f.key} label={f.label} hint={f.hint} max={f.max}
                    value={policy[f.key]} disabled={disabled} onCommit={(v) => void savePolicy({ [f.key]: v })} />
                ))}
              </div>
            </section>
          )}

          <section aria-label="Roles">
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">Roles</h2>
            <div className="divide-y rounded-lg border">
              {data.roles.map((r) => {
                const holder = r.default_teammate_id ? byId.get(r.default_teammate_id) : undefined
                return (
                  <div key={r.role} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">
                        <span className="font-medium">{WORK_ROLE_LABELS[r.role]}</span>
                        {holder && <span className="text-muted-foreground"> · {holder.name}</span>}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {r.attemptable ? autonomyLine(holder) : holder ? 'Suggests work only (a developer’s change needs a coding run)' : NO_HOLDER}
                      </p>
                    </div>
                    {r.breaker?.paused && (
                      <>
                        <span
                          className="flex shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400"
                          title={`Its last ${r.breaker.window} first passes were all dismissed.`}
                        >
                          <PauseCircle className="h-3 w-3" />
                          Paused
                        </span>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => void resume(r.role)}
                          className="flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <PlayCircle className="h-3.5 w-3.5" />
                          Resume {WORK_ROLE_LABELS[r.role]}
                        </button>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              A role’s work goes to the oldest teammate holding it. A person can still hand a card to any teammate.
            </p>
          </section>

          {data.teammates.length > 0 && (
            <section aria-label="Teammates">
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">Teammates</h2>
              <div className="divide-y rounded-lg border">
                {data.teammates.map((t) => (
                  <div key={t.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.name}</span>
                    <select
                      aria-label={`${t.name} role`}
                      value={t.role ?? ''}
                      disabled={disabled}
                      onChange={(e) => void saveTeammate(t.id, { role: (e.target.value || null) as WorkRole | null })}
                      className="h-8 rounded-md border border-border bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <option value="">No role</option>
                      {WORK_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {WORK_ROLE_LABELS[role]}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={`${t.name} autonomy`}
                      value={t.autonomy ?? 'propose'}
                      disabled={disabled}
                      onChange={(e) => void saveTeammate(t.id, { autonomy: e.target.value as AgentAutonomyMode })}
                      className="h-8 rounded-md border border-border bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <option value="attempt">Makes first passes</option>
                      <option value="propose">Suggests only</option>
                      <option value="off">Off</option>
                    </select>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

function NumberRow({
  label,
  hint,
  value,
  max,
  suffix,
  disabled,
  onCommit,
}: {
  label: string
  hint: string
  value: number
  max: number
  suffix?: string
  disabled: boolean
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const n = Number(draft)
  const valid = draft.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= max
  const commit = () => {
    if (!valid) {
      setDraft(String(value))
      toast.error(`Enter a whole number from 0 to ${max}`)
      return
    }
    if (n !== value) onCommit(n)
  }
  return (
    <label className="flex items-center gap-3 px-4 py-3">
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
      </span>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        max={max}
        value={draft}
        disabled={disabled}
        aria-invalid={!valid}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        className="h-8 w-20 rounded-md border border-border bg-background px-2 text-right text-sm tabular-nums disabled:cursor-not-allowed disabled:opacity-60"
      />
      {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
    </label>
  )
}

/** The attempt bar, shown as a percent; empty means the triage flow's own bar. */
function ConfidenceRow({
  value,
  disabled,
  onCommit,
}: {
  value: number | null
  disabled: boolean
  onCommit: (v: number | null) => void
}) {
  const shown = value === null ? '' : String(Math.round(value * 100))
  const [draft, setDraft] = useState(shown)
  useEffect(() => setDraft(shown), [shown])
  const n = Number(draft)
  const empty = draft.trim() === ''
  const valid = empty || (Number.isInteger(n) && n >= 0 && n <= 100)
  const commit = () => {
    if (!valid) {
      setDraft(shown)
      toast.error('Enter a whole percent from 0 to 100, or leave it empty')
      return
    }
    const next = empty ? null : n / 100
    if (next !== value) onCommit(next)
  }
  return (
    <label className="flex items-center gap-3 px-4 py-3">
      <span className="min-w-0 flex-1">
        <span className="block text-sm">Confidence needed for a first pass</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          Below it, the work comes as a card with Start. Empty uses the triage flow’s own bar.
        </span>
      </span>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        max={100}
        value={draft}
        placeholder="Flow"
        disabled={disabled}
        aria-label="Confidence needed for a first pass"
        aria-invalid={!valid}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        className="h-8 w-20 rounded-md border border-border bg-background px-2 text-right text-sm tabular-nums disabled:cursor-not-allowed disabled:opacity-60"
      />
      <span className="text-xs text-muted-foreground">%</span>
    </label>
  )
}
