'use client'

/**
 * "Its agent" (docs/plans/bots-v3.md, Phase 3): who tells you about a loop.
 * Every loop has one: it can be changed, never cleared.
 *
 *   - Your teammates' agents: the teammates you can reach that may front loops
 *     (Triage and Reconciler among the built-in ones), each with what it already
 *     speaks for. Picking one points the loop at that teammate.
 *   - A new agent for this loop: always a new work agent, made when you save
 *     (`bot_new`: never an existing teammate), under the name you give it (or,
 *     with none, the name of the face the server hands it).
 *   - The loop's own work agent (`fronts_only`): rename it or delete it here
 *     (through /api/account/work-bots/[id]); whoever can edit the loop may.
 *
 * A seeded Triage or Reconciler loop keeps its own built-in teammate: shown,
 * not changeable. Every agent wears the one agent mark (AgentIcon).
 *
 * FlowBotChip is the header button that shows the loop's agent and opens this.
 */
import { useId, useState } from 'react'
import { AlertTriangle, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { AgentIcon } from '@/components/agents/agent-icon'
import { announceTeammatesChanged } from '@/lib/bots/teammates-changed'
import { SYSTEM_TEAMMATE_BLURBS, type SystemTeammateKey } from '@/lib/work/system-teammates'
import { cn } from '@/lib/utils'
import { SEEDED_BOT_KEYS, type EditorBot, type EditorState, type FlowBotOption, type FlowBotOptions, type FlowBotSummary } from './flow-types'

/** What a new agent is called until it's named: the server names an unnamed one after the face it hands it. */
const NEW_AGENT_NAME = 'A new agent'

/** What a teammate's agent speaks for, in a line. */
export function botSpeaksFor(option: Pick<FlowBotOption, 'is_system' | 'system_key' | 'fronts' | 'agent'>): string {
  if (option.is_system && option.system_key && option.system_key in SYSTEM_TEAMMATE_BLURBS) {
    return SYSTEM_TEAMMATE_BLURBS[option.system_key as SystemTeammateKey]
  }
  // A custom persona's agent (bots-v3 Phase 6) speaks for its persona first.
  if (option.agent) {
    return option.fronts.length > 0 ? `Speaks for ${option.agent} +${option.fronts.length}` : `Speaks for ${option.agent}`
  }
  if (option.fronts.length === 0) return 'Doesn’t speak for a loop yet'
  const shown = option.fronts.slice(0, 2).join(', ')
  return `Speaks for ${shown}${option.fronts.length > 2 ? ` +${option.fronts.length - 2}` : ''}`
}

/** The name the editor's current agent shows, from the options or the saved summary. */
export function currentBotLook(
  bot: EditorBot | null,
  options: FlowBotOptions | null,
  summary: FlowBotSummary | null,
  loopName: string,
): { name: string } | null {
  if (!bot) return null
  if (bot.kind === 'new') return { name: bot.name.trim() || NEW_AGENT_NAME }
  const option = options?.teammates.find((t) => t.id === bot.id)
  if (option) return { name: option.name }
  if (summary && summary.id === bot.id) return { name: summary.name }
  return { name: 'An agent on a private team' }
}

/** The header button: the loop's agent, its mark and name, or a nudge when it has none. */
export function FlowBotChip({
  editor,
  options,
  onOpen,
}: {
  editor: EditorState
  options: FlowBotOptions | null
  onOpen: () => void
}) {
  const look = currentBotLook(editor.bot, options, editor.botSummary, editor.name)
  const missing = !look && !!editor.id
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn('h-8 gap-1.5', missing && 'border-amber-500/50 text-amber-700 dark:text-amber-400')}
      onClick={onOpen}
      title="Its agent: who tells you about this loop"
      data-flow-bot-chip=""
    >
      {look ? (
        <>
          <AgentIcon />
          <span className="max-w-[10rem] truncate">{look.name}</span>
        </>
      ) : missing ? (
        <>
          <AlertTriangle className="h-3.5 w-3.5" />
          Pick an agent
        </>
      ) : (
        <span className="text-muted-foreground">Its agent</span>
      )}
    </Button>
  )
}

export function FlowBotPicker({
  editor,
  setEditor,
  options,
  loading,
  onBotsChanged,
}: {
  editor: EditorState
  setEditor: (e: EditorState) => void
  options: FlowBotOptions | null
  loading: boolean
  /** A work agent was renamed or deleted here: reload the options. */
  onBotsChanged?: () => void
}) {
  const nameId = useId()
  const seeded = editor.seed_key ? SEEDED_BOT_KEYS[editor.seed_key] : undefined
  const pick = (bot: EditorBot) => setEditor({ ...editor, bot, botDirty: true })
  const look = currentBotLook(editor.bot, options, editor.botSummary, editor.name)

  if (seeded) {
    return (
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-muted-foreground">A built-in loop keeps its own teammate: its runs always come through it.</p>
        {look && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
            <AgentIcon className="h-4 w-4" />
            <span className="font-medium">{look.name}</span>
          </div>
        )}
      </div>
    )
  }

  const teammates = options?.teammates ?? []
  const pickedTeammate = editor.bot?.kind === 'teammate' ? editor.bot.id : null
  const pickedNew = editor.bot?.kind === 'new' ? editor.bot : null
  // The loop's work agent as saved: the one it names now, not a pick still unsaved.
  const ownWorkBot =
    pickedTeammate && !editor.botDirty ? teammates.find((t) => t.id === pickedTeammate && t.fronts_only) ?? null : null

  return (
    <div className="space-y-5">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Who tells you about this loop. When it runs and leaves something, its agent brings it to you, and you talk it through with the agent.
      </p>

      {editor.id && !editor.bot && (
        <p role="status" className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Its agent was removed. Pick one so its runs come through an agent.
        </p>
      )}

      {ownWorkBot && (
        <WorkBotManager
          key={ownWorkBot.id}
          bot={ownWorkBot}
          onChanged={(change) => {
            if (change.kind === 'deleted') {
              // Its loops lost their agent (ON DELETE SET NULL): this one asks for a new pick.
              setEditor({ ...editor, bot: null, botDirty: false, botSummary: null })
            } else if (editor.botSummary?.id === ownWorkBot.id) {
              setEditor({ ...editor, botSummary: { ...editor.botSummary, ...change.fields } })
            }
            onBotsChanged?.()
          }}
        />
      )}

      <section aria-label="Your agents" className="space-y-1.5">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Your agents</h3>
        {loading && !options ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : teammates.length === 0 ? (
          <p className="text-xs text-muted-foreground">None yet: make a new one below.</p>
        ) : (
          <div role="radiogroup" aria-label="Your agents" className="space-y-1">
            {teammates.map((t) => {
              const selected = pickedTeammate === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-bot-option={t.id}
                  onClick={() => pick({ kind: 'teammate', id: t.id })}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    selected ? 'border-primary bg-primary/10' : 'border-transparent bg-muted/40 hover:bg-muted',
                  )}
                >
                  <AgentIcon className="h-4 w-4" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{t.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{botSpeaksFor(t)}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </section>

      <section aria-label="A new agent for this loop" className="space-y-1.5">
        <button
          type="button"
          aria-pressed={!!pickedNew}
          data-new-agent=""
          onClick={() => pick({ kind: 'new', name: pickedNew?.name ?? '' })}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left text-sm transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            pickedNew ? 'border-primary bg-primary/10' : 'border-transparent bg-muted/40 hover:bg-muted',
          )}
        >
          <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">A new agent for this loop</span>
        </button>
        {pickedNew && (
          <div className="space-y-1 pt-1">
            <label htmlFor={nameId} className="text-xs font-medium">
              Its name
            </label>
            <Input
              id={nameId}
              value={pickedNew.name}
              placeholder="Named for you if left blank"
              maxLength={60}
              onChange={(e) => pick({ kind: 'new', name: e.target.value })}
            />
            <p className="text-[11px] text-muted-foreground">Made when you save. It speaks for this loop and takes no assignments.</p>
          </div>
        )}
      </section>
    </div>
  )
}

type WorkBotChange = { kind: 'deleted' } | { kind: 'updated'; fields: { name?: string } }

/**
 * The loop's own work agent: rename it or delete it, through
 * /api/account/work-bots/[id]. Deleting it takes it off every loop it fronts;
 * the server refuses while other people have a chat with it (their threads
 * would go with it).
 */
function WorkBotManager({ bot, onChanged }: { bot: FlowBotOption; onChanged: (change: WorkBotChange) => void }) {
  const nameId = useId()
  const [name, setName] = useState(bot.name)
  const [busy, setBusy] = useState(false)

  async function send(method: 'PATCH' | 'DELETE', body?: Record<string, unknown>): Promise<boolean> {
    setBusy(true)
    try {
      const res = await fetch(`/api/account/work-bots/${encodeURIComponent(bot.id)}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null
        toast.error(err?.error ?? 'That didn’t work')
        return false
      }
      // Renamed or gone: the Agents list shows it now.
      announceTeammatesChanged()
      return true
    } catch {
      toast.error('That didn’t work')
      return false
    } finally {
      setBusy(false)
    }
  }

  const trimmed = name.replace(/\s+/g, ' ').trim()
  const others = bot.fronts.length > 1 ? ` It also speaks for ${bot.fronts.length - 1} other loop${bot.fronts.length > 2 ? 's' : ''}.` : ''

  return (
    <section aria-label="This loop’s agent" className="space-y-2 rounded-md border border-border p-3" data-work-bot-manager={bot.id}>
      <div className="flex items-center gap-2">
        <AgentIcon className="h-4 w-4" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{bot.name}</span>
      </div>
      <div className="space-y-1">
        <label htmlFor={nameId} className="text-xs font-medium">
          Its name
        </label>
        <div className="flex gap-1.5">
          <Input id={nameId} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} className="h-8" />
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={busy || !trimmed || trimmed === bot.name}
            onClick={async () => {
              if (await send('PATCH', { name: trimmed })) onChanged({ kind: 'updated', fields: { name: trimmed } })
            }}
          >
            Rename
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1 text-destructive"
          disabled={busy}
          onClick={async () => {
            if (!confirm(`Delete ${bot.name}? Its loops will each ask for a new agent.${others}`)) return
            if (await send('DELETE')) onChanged({ kind: 'deleted' })
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete agent
        </Button>
      </div>
    </section>
  )
}
