'use client'

/**
 * Settings → Preferences → Assistant → Model (roadmap #9): the model the
 * person's main agent runs on, wherever they talk to it (the web and desktop
 * apps, the iPhone app, Slack, text). One control, Auto by default (today's
 * model, src/lib/ai/agent-model.ts); the agent still picks each helper's
 * model itself. Read and saved through /api/account/agent-model, on the
 * account, so it follows the person to every device.
 *
 *  - On the free tier (their own ChatGPT plan) there is nothing to pick: the
 *    plan's model runs every turn, so the row says which, with no dropdown.
 *  - On an unpaid plan the premium models are listed but can't be picked; a
 *    premium model saved earlier says it runs Auto until they're on a paid
 *    plan, as each turn does.
 *  - A pick saves at once and applies from the agent's next reply; a save
 *    the account refuses puts the old pick back and says so.
 *
 * The dropdown is the page's own (the Theme one in ./preferences-view.tsx),
 * with listbox roles, and closes on Escape or a press outside it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { BrainCircuit, Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  AGENT_MODEL_OPTIONS,
  AUTO_AGENT_MODEL,
  AUTO_AGENT_MODEL_DESCRIPTION,
  agentModelName,
  isPremiumAgentModel,
  parseAgentModelChoice,
  type AgentModelChoice,
} from '@/lib/ai/agent-model'

export const AGENT_MODEL_URL = '/api/account/agent-model'

type Plan = 'chatgpt' | 'paid' | 'unpaid' | null

interface Loaded {
  model: AgentModelChoice
  plan: Plan
  planModel: string | null
}

function choiceLabel(choice: AgentModelChoice): string {
  return choice === AUTO_AGENT_MODEL ? 'Auto' : agentModelName(choice)
}

function parsePlan(raw: unknown): Plan {
  return raw === 'chatgpt' || raw === 'paid' || raw === 'unpaid' ? raw : null
}

interface Item {
  id: AgentModelChoice
  label: string
  description: string
  locked: boolean
}

export function AgentModelSection() {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<AgentModelChoice | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    fetch(AGENT_MODEL_URL)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const body = (await res.json()) as Record<string, unknown>
        if (!live) return
        setLoaded({
          model: parseAgentModelChoice(body.model) ?? AUTO_AGENT_MODEL,
          plan: parsePlan(body.plan),
          planModel: typeof body.planModel === 'string' ? body.planModel : null,
        })
      })
      .catch(() => {
        if (live) setLoadFailed(true)
      })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (!open) return
    // pointerdown, not mousedown: Tauri's drag script swallows mousedown on
    // the settings shell's title-bar drag strip (as the Theme dropdown says).
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const choose = useCallback(
    async (next: AgentModelChoice) => {
      setOpen(false)
      if (!loaded || next === loaded.model) return
      const before = loaded.model
      setLoaded({ ...loaded, model: next })
      setSaving(true)
      setError(null)
      setSaved(null)
      try {
        const res = await fetch(AGENT_MODEL_URL, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: next }),
        })
        if (!res.ok) throw new Error(String(res.status))
        setSaved(next)
      } catch {
        setLoaded((current) => (current ? { ...current, model: before } : current))
        setError('Couldn’t save the model. Your assistant keeps the one it had.')
      } finally {
        setSaving(false)
      }
    },
    [loaded],
  )

  const onPlan = loaded?.plan === 'chatgpt'
  const items: Item[] = [
    { id: AUTO_AGENT_MODEL, label: 'Auto', description: AUTO_AGENT_MODEL_DESCRIPTION, locked: false },
    ...AGENT_MODEL_OPTIONS.map((o) => ({ id: o.id, label: o.label, description: o.description, locked: o.premium && loaded?.plan === 'unpaid' })),
  ]
  const current = loaded?.model ?? AUTO_AGENT_MODEL
  // A premium model saved before the plan lapsed: each turn runs Auto.
  const heldBack = loaded?.plan === 'unpaid' && current !== AUTO_AGENT_MODEL && isPremiumAgentModel(current)

  return (
    <div data-testid="agent-model-section">
      <div className="flex items-center justify-between gap-6 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <BrainCircuit className="h-4.5 w-4.5 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p id="agent-model-label" className="text-sm font-medium">
              Model
            </p>
            <p className="text-[13px] text-muted-foreground">
              {onPlan
                ? `Your assistant runs on your ChatGPT plan’s model${loaded?.planModel ? `, ${loaded.planModel}` : ''}. You can pick another model on a Dial8 plan.`
                : 'What your assistant runs on, wherever you talk to it. It still picks the right model for each helper it starts.'}
            </p>
          </div>
        </div>
        {!onPlan && (
          <div className="relative shrink-0" ref={ref}>
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-labelledby="agent-model-label agent-model-value"
              disabled={!loaded || saving}
              onClick={() => setOpen((o) => !o)}
              className="flex w-48 items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span id="agent-model-value" className="truncate">
                {loaded ? choiceLabel(current) : loadFailed ? 'Unavailable' : 'Loading…'}
              </span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>
            {open && (
              <div
                role="listbox"
                aria-labelledby="agent-model-label"
                className="absolute right-0 top-full z-10 mt-1 w-80 rounded-3xl border border-border bg-popover p-2 shadow-md"
              >
                {items.map((item) => {
                  const selected = item.id === current
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      aria-disabled={item.locked}
                      disabled={item.locked}
                      onClick={() => void choose(item.id)}
                      className={cn(
                        'flex w-full items-start gap-2 rounded-2xl px-2.5 py-2 text-left transition-colors',
                        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50',
                        item.locked && 'cursor-not-allowed opacity-50 hover:bg-transparent',
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          {item.label}
                          {item.locked && (
                            <span className="rounded-full border border-border px-1.5 py-px text-[10px] font-normal text-muted-foreground">
                              Paid plans
                            </span>
                          )}
                        </span>
                        <span className="block text-xs text-muted-foreground">{item.description}</span>
                      </span>
                      {/* Rendered only when picked: the global `.lucide` opacity beats an opacity utility. */}
                      {selected ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <span className="h-3.5 w-3.5 shrink-0" />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="-mt-2 px-5 pb-4 text-xs text-destructive">
          {error}
        </p>
      )}
      {!error && heldBack && (
        <p className="-mt-2 px-5 pb-4 text-xs text-muted-foreground">
          {choiceLabel(current)} needs a paid plan, so your assistant runs on Auto for now.
        </p>
      )}
      {!error && !heldBack && saved && (
        <p className="-mt-2 flex items-center gap-1 px-5 pb-4 text-xs text-muted-foreground">
          <Check className="h-3.5 w-3.5 text-emerald-500" /> Saved. Your assistant runs on {choiceLabel(saved)} from its next reply.
        </p>
      )}
    </div>
  )
}
