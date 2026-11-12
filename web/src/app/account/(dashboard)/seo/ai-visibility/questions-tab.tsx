'use client'

/**
 * A tracker's Questions tab (tab id `prompts`): the questions it asks, each
 * with a switch to stop asking it for now, where it came from, and the last
 * finished check's mark per assistant. "Add questions" opens a small dialog;
 * a selection gets "Remove · 3" (ConfirmDialog; past answers stay).
 *
 * Below, "Find questions people already ask": a brand or site, and Search
 * (it spends; the route asks for a yes above about $0.25), listing recorded
 * questions whose AI answers mention it, with the brands those answers
 * named and an Add per row. A stored answer says when it was looked up, with
 * Refresh to buy it again. A partial answer (a part could not be looked up
 * after earlier parts were bought) shows the route's note in a quiet line,
 * with Refresh; a questions part that did not come back lists nothing.
 *
 * Turning questions on, or adding them, on a tracker whose schedule runs
 * raises what it spends each month, by any amount: the route answers 409
 * CONFIRMATION_REQUIRED with the estimates (now and after), which are shown
 * in the spend dialog; the request is sent again with `confirmed` only on
 * the press of the button that names the cost. Lookups off (a guest, the
 * free plan) is a neutral banner in the route's words; a check that could
 * not run just now (CHECK_FAILED) is an ordinary failure with Try again,
 * which asks afresh.
 */
import * as React from 'react'
import { Loader2, Plus, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import type { AiMentionsExploreResult } from '@/lib/seo/ai-visibility/explore'
import type { AiExploredQuestion, AiPromptView, AiRunView, AiTrackerView } from '@/lib/seo/ai-visibility/view'
import { cn } from '@/lib/utils'
import { errorCode, errorMessage } from '../api'
import { count, relativeWhen } from '../ui-helpers'
import { aboutUsd, addedWords, monthlyWords, orderedEngines } from './ai-helpers'
import { DATA_OFF_CODES, addPrompts, confirmationOf, exploreQuestions, removePrompts, setPromptsActive, type AiConfirmation } from './api'
import { ENGINE_SHORT, Mark, answersByPrompt, useRunAnswers } from './results-tab'
import { AddQuestionsDialog, SpendConfirmDialog, retryAction } from './tracker-dialogs'

/** The selection island's slab (views/bulk-actions/bulk-action-bar.tsx's SELECTION_ISLAND_CLASS). */
const ISLAND =
  'flex max-w-full flex-wrap items-center justify-center gap-1 rounded-full border border-border bg-background/95 p-1.5 shadow-lg shadow-black/10 backdrop-blur-xl dark:shadow-black/50'

/** A route's 409 CONFIRMATION_REQUIRED waiting for the person: its cost, and the request again with `confirmed`. */
type Pending = { title: string; confirmation: AiConfirmation; label: string; run: () => Promise<void> } | null

export function QuestionsTab({
  tracker,
  prompts,
  latestRun,
  version,
  buyBlocked,
  onChanged,
  onDataOff,
  onSpent,
}: {
  tracker: AiTrackerView
  prompts: AiPromptView[]
  latestRun: AiRunView | null
  version: number
  /** Why lookups can't be bought now, or null. */
  buyBlocked: string | null
  onChanged: () => void
  onDataOff: () => void
  onSpent: () => void
}) {
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set())
  const [toggling, setToggling] = React.useState<string | null>(null)
  const [addOpen, setAddOpen] = React.useState(false)
  const [confirmRemove, setConfirmRemove] = React.useState(false)
  const [removing, setRemoving] = React.useState(false)
  const [pending, setPending] = React.useState<Pending>(null)
  const [pendingBusy, setPendingBusy] = React.useState(false)
  /** Lookups off for this person (a guest, the free plan): the route's own words, in the page's neutral banner. */
  const [notice, setNotice] = React.useState<string | null>(null)
  const { rows } = useRunAnswers(latestRun?.id ?? null, 'all', version)
  const byPrompt = React.useMemo(() => answersByPrompt(rows), [rows])
  const engines = latestRun ? orderedEngines(latestRun.engines) : []

  // A selection only holds rows still listed.
  React.useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(prompts.map((p) => p.id))
      const next = new Set([...prev].filter((id) => ids.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [prompts])

  /** The route asked for a yes: its cost on screen, and only the press of the button naming it sends `confirmed`. */
  const ask = (confirmation: AiConfirmation, title: string, run: () => Promise<void>) => {
    setPending({
      title,
      confirmation,
      label: confirmation.estimate ? `Go ahead, ${monthlyWords(confirmation.estimate)}` : 'Go ahead',
      run,
    })
  }

  /** A refusal that is not about the cost: lookups off is the banner, the rest an ordinary failure. */
  const refused = (err: unknown, title: string, again: () => void) => {
    const code = errorCode(err)
    setPending(null)
    if (code && DATA_OFF_CODES.has(code)) {
      setNotice(errorMessage(err))
      onDataOff()
    } else toast.error(title, { description: errorMessage(err, 'Try again in a moment.'), ...retryAction(code, again) })
  }

  const toggle = async (prompt: AiPromptView, active: boolean, confirmed = false) => {
    setToggling(prompt.id)
    setNotice(null)
    try {
      await setPromptsActive(tracker.id, [prompt.id], active, confirmed)
      setPending(null)
      onChanged()
    } catch (err) {
      const asking = confirmationOf(err)
      if (asking) ask(asking, 'Ask this question again?', () => toggle(prompt, active, true))
      // Try again asks afresh: the cost is shown again before any yes is sent.
      else refused(err, active ? 'Could not turn the question on' : 'Could not pause the question', () => void toggle(prompt, active))
    } finally {
      setToggling(null)
    }
  }

  const remove = async () => {
    setRemoving(true)
    try {
      const ids = [...selected]
      await removePrompts(tracker.id, ids)
      setConfirmRemove(false)
      setSelected(new Set())
      toast(`Removed ${count(ids.length, 'question')}. Past answers stay in their checks.`)
      onChanged()
    } catch (err) {
      toast.error('Could not remove the questions', { description: errorMessage(err, 'Try again in a moment.') })
    } finally {
      setRemoving(false)
    }
  }

  /** A found question's Add; `onAdded` once it is in, right away or after the person said yes to its cost. */
  const addOne = async (question: string, onAdded: () => void, confirmed = false): Promise<void> => {
    setNotice(null)
    try {
      const out = await addPrompts(tracker.id, [{ text: question, source: 'suggested' }], confirmed)
      setPending(null)
      toast(addedWords(out))
      onChanged()
      if (out.added > 0 || out.skipped_duplicates > 0) onAdded()
    } catch (err) {
      const asking = confirmationOf(err)
      if (asking) ask(asking, 'Add this question?', () => addOne(question, onAdded, true))
      // Try again asks afresh: the cost is shown again before any yes is sent.
      else refused(err, 'Could not add the question', () => void addOne(question, onAdded))
    }
  }

  const selecting = selected.size > 0
  const active = prompts.filter((p) => p.active).length

  return (
    <div data-seo-questions-tab="" className="@container space-y-8">
      <section>
        {notice && (
          <p data-seo-banner="questions" className="mb-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            {notice}
          </p>
        )}
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">
            {prompts.length === 0 ? 'Nothing is asked yet.' : active === prompts.length ? `Every check asks all ${count(prompts.length, 'question')}.` : `Every check asks ${active.toLocaleString()} of ${count(prompts.length, 'question')}.`}
          </p>
          <Button variant="outline" size="sm" data-seo-add-questions="" className="h-7 text-xs" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1 h-3 w-3" />
            Add questions
          </Button>
        </div>
        {prompts.length === 0 ? (
          <div data-seo-questions-empty="" className="py-10 text-center">
            <p className="text-sm font-medium text-foreground">No questions yet</p>
            <p className="mt-1 text-xs text-muted-foreground">Add the questions your customers would ask, or find ones people already ask below.</p>
          </div>
        ) : (
          <>
          {engines.length > 0 && (
            <div aria-hidden className="hidden items-center gap-2 px-1 pb-1 @md:flex">
              <span className="w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">Question</span>
              <span className="flex shrink-0 items-center" title="The last finished check’s answers">
                {engines.map((e) => (
                  <span key={e} className="w-14 truncate text-center text-[10px] text-muted-foreground">
                    {ENGINE_SHORT[e]}
                  </span>
                ))}
              </span>
              <span className="ml-1 w-9 shrink-0 text-right text-[11px] text-muted-foreground">Asked</span>
            </div>
          )}
          <ul>
            {prompts.map((p) => {
              const answers = byPrompt.get(p.id)
              const isSelected = selected.has(p.id)
              return (
                <li
                  key={p.id}
                  data-seo-prompt-row={p.id}
                  data-seo-prompt-active={p.active ? 'on' : 'off'}
                  className={cn('group flex items-center gap-2 rounded-md px-1 py-1.5 transition-colors hover:bg-muted/40', isSelected && 'bg-muted/40')}
                >
                  <Checkbox
                    data-seo-select-prompt={p.id}
                    checked={isSelected}
                    onCheckedChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev)
                        if (next.has(p.id)) next.delete(p.id)
                        else next.add(p.id)
                        return next
                      })
                    }
                    aria-label={`Select “${p.text}”`}
                    className={cn('h-3.5 w-3.5 transition-opacity', selecting || isSelected ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100')}
                  />
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className={cn('min-w-0 truncate text-xs', p.active ? 'text-foreground' : 'text-muted-foreground')} title={p.text}>
                      {p.text}
                    </span>
                    {p.source === 'suggested' && (
                      <span title="Found with the question search" className="inline-flex shrink-0 items-center rounded-full border border-border px-1.5 py-px text-[10px] text-muted-foreground">
                        Found
                      </span>
                    )}
                  </span>
                  {engines.length > 0 && (
                    <span className="hidden shrink-0 items-center @md:flex" aria-label="The last check’s answers">
                      {engines.map((e) => (
                        <Mark key={e} engine={e} row={answers?.get(e)} />
                      ))}
                    </span>
                  )}
                  <Switch
                    data-seo-prompt-switch={p.id}
                    checked={p.active}
                    disabled={toggling === p.id}
                    onCheckedChange={(on) => void toggle(p, on)}
                    aria-label={p.active ? `Stop asking “${p.text}”` : `Ask “${p.text}” again`}
                    title={p.active ? 'Asked in every check. Turn off to skip it for now.' : 'Skipped for now. Turn on to ask it again.'}
                    className="ml-1 shrink-0 origin-right scale-75"
                  />
                </li>
              )
            })}
          </ul>
          </>
        )}
        {selecting && (
          <div className="pointer-events-none sticky bottom-3 z-10 mt-3 flex justify-center">
            <div data-seo-selection="" className={cn(ISLAND, 'pointer-events-auto')}>
              <button
                type="button"
                data-seo-remove-selected=""
                onClick={() => setConfirmRemove(true)}
                className="inline-flex h-7 items-center rounded-full bg-foreground px-3 text-xs font-medium tabular-nums text-background"
              >
                Remove · {selected.size.toLocaleString()}
              </button>
              <button
                type="button"
                data-seo-clear-selection=""
                aria-label="Clear the selection"
                title="Clear the selection"
                onClick={() => setSelected(new Set())}
                className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </section>

      <FindQuestions tracker={tracker} buyBlocked={buyBlocked} onAdd={addOne} onDataOff={onDataOff} onSpent={onSpent} />

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={(open) => {
          if (!removing) setConfirmRemove(open)
        }}
        title={`Remove ${count(selected.size, 'question')}?`}
        description="They are no longer asked. Their past answers stay in the checks they were part of."
        confirmLabel="Remove"
        busy={removing}
        onConfirm={() => void remove()}
      />
      <SpendConfirmDialog
        open={pending !== null}
        title={pending?.title ?? ''}
        description="The scheduled checks will ask it too. They are paid for from this workspace’s search data."
        confirmation={pending?.confirmation ?? null}
        confirmationLead="This raises what the tracker spends on its own."
        confirmLabel={pending?.label ?? 'Go ahead'}
        busy={pendingBusy}
        onClose={() => setPending(null)}
        onConfirm={() => {
          const p = pending
          if (!p) return
          setPendingBusy(true)
          void p.run().finally(() => setPendingBusy(false))
        }}
      />
      <AddQuestionsDialog
        open={addOpen}
        tracker={tracker}
        promptCount={prompts.length}
        activeCount={active}
        onClose={() => setAddOpen(false)}
        onAdded={onChanged}
        onDataOff={onDataOff}
      />
    </div>
  )
}

/** "Find questions people already ask": the explorer, a lookup the person asks for. */
function FindQuestions({
  tracker,
  buyBlocked,
  onAdd,
  onDataOff,
  onSpent,
}: {
  tracker: AiTrackerView
  buyBlocked: string | null
  /** Add a found question; `onAdded` runs once it is in (after a yes to its cost, when the route asks for one). */
  onAdd: (question: string, onAdded: () => void) => Promise<void>
  onDataOff: () => void
  onSpent: () => void
}) {
  const [target, setTarget] = React.useState(tracker.domain || tracker.brand_name)
  const [found, setFound] = React.useState<AiMentionsExploreResult | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [confirm, setConfirm] = React.useState<{ usd: number | null; message: string; refresh: boolean } | null>(null)
  const [added, setAdded] = React.useState<ReadonlySet<string>>(() => new Set())
  const [adding, setAdding] = React.useState<string | null>(null)
  const asked = React.useRef(0)

  const search = async (opts: { refresh?: boolean; confirmed?: boolean } = {}) => {
    const t = target.trim()
    if (!t || busy || buyBlocked) return
    const ask = ++asked.current
    setBusy(true)
    setNotice(null)
    try {
      const out = await exploreQuestions({
        target: t,
        location_code: tracker.location_code,
        language_code: tracker.language_code,
        ...(opts.refresh ? { refresh: true } : {}),
        ...(opts.confirmed ? { confirmed: true } : {}),
      })
      if (ask !== asked.current) return
      setConfirm(null)
      setFound(out.explore)
      if (!out.explore.from_cache) onSpent()
    } catch (err) {
      if (ask !== asked.current) return
      const asking = confirmationOf(err)
      const code = errorCode(err)
      if (asking) setConfirm({ usd: asking.estimate_usd, message: asking.message, refresh: !!opts.refresh })
      else {
        setConfirm(null)
        if (code === 'SPEND_LIMIT_REACHED') setNotice(errorMessage(err))
        else if (code && DATA_OFF_CODES.has(code)) {
          setNotice(errorMessage(err))
          onDataOff()
        } else if (code === 'VALIDATION_ERROR') setNotice(errorMessage(err))
        // Try again asks afresh: a price is shown again before any yes is sent.
        else toast.error('Could not search for questions', { description: errorMessage(err, 'Try again in a moment.'), ...retryAction(code, () => void search({ refresh: opts.refresh })) })
      }
    } finally {
      if (ask === asked.current) setBusy(false)
    }
  }

  const add = async (q: AiExploredQuestion) => {
    setAdding(q.question)
    try {
      await onAdd(q.question, () => setAdded((prev) => new Set(prev).add(q.question.toLowerCase())))
    } finally {
      setAdding(null)
    }
  }

  // A partial lookup: the questions part may not have come back (null), which is nothing to list.
  const questions = found?.questions ?? []
  const noQuestionsPart = found !== null && found.questions === null
  const partialNote = found?.partial?.note ?? null
  return (
    <section data-seo-find-questions="" className="space-y-2">
      <div>
        <h2 className="text-xs font-medium text-foreground">Find questions people already ask</h2>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          Questions put to AI assistants whose answers mention a business or site, from a record of real answers. Each search is paid
          for from this workspace’s search data.
        </p>
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void search()
        }}
      >
        <Input
          data-seo-explore-target=""
          aria-label="A brand or website"
          value={target}
          placeholder="A brand or website"
          spellCheck={false}
          onChange={(e) => setTarget(e.target.value)}
          className="h-8 max-w-xs text-sm"
        />
        <Button type="submit" size="sm" data-seo-explore-search="" className="h-8 shrink-0" disabled={busy || !target.trim() || !!buyBlocked} title={buyBlocked ?? 'Look up the questions whose answers mention it'}>
          {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Search className="mr-1.5 h-3.5 w-3.5" />}
          Search
        </Button>
      </form>
      <SpendConfirmDialog
        open={confirm !== null}
        title={`Search for questions about ${target.trim()}?`}
        description={confirm ? (confirm.usd !== null ? `This search costs ${aboutUsd(confirm.usd)}, paid for from this workspace’s search data. What it finds is kept for a day.` : confirm.message) : ''}
        confirmLabel={confirm?.usd !== null && confirm?.usd !== undefined ? `Search, ${aboutUsd(confirm.usd)}` : 'Search'}
        busy={busy}
        onClose={() => setConfirm(null)}
        onConfirm={() => void search({ confirmed: true, refresh: confirm?.refresh })}
      />
      {notice && (
        <p data-seo-banner="explore" className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {notice}
        </p>
      )}
      {found && (
        <div data-seo-explore-results="">
          <div className="flex flex-wrap items-center gap-2 pb-1 text-[11px] text-muted-foreground">
            <span className="min-w-0 flex-1">
              {noQuestionsPart
                ? null
                : questions.length === 0
                  ? `No recorded questions mention ${found.target}.`
                  : `${count(questions.length, 'question')} whose answers mention ${found.target}`}
            </span>
            {(found.from_cache || partialNote) && (
              <>
                {found.from_cache && (
                  <span data-seo-explore-cached="" title={found.fetched_at}>
                    Looked up {relativeWhen(found.fetched_at)}
                  </span>
                )}
                <Button variant="ghost" size="sm" data-seo-explore-refresh="" className="-my-1 h-6 px-2 text-[11px]" disabled={busy || !!buyBlocked} title={buyBlocked ?? 'Look it up again (paid)'} onClick={() => void search({ refresh: true })}>
                  Refresh
                </Button>
              </>
            )}
          </div>
          {partialNote && (
            <p data-seo-explore-partial="" className="pb-1 text-[11px] leading-relaxed text-muted-foreground">
              {partialNote}
            </p>
          )}
          {questions.length > 0 && (
            <ul className="divide-y divide-border">
              {questions.map((q) => {
                const tracked = q.tracked || added.has(q.question.toLowerCase())
                return (
                  <li key={q.question} data-seo-explore-row="" className="flex items-center gap-3 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-foreground" title={q.question}>
                        {q.question}
                      </span>
                      {q.brands_named.length > 0 && (
                        <span className="block truncate text-[11px] text-muted-foreground" title={q.brands_named.join(', ')}>
                          Answers name {q.brands_named.slice(0, 6).join(', ')}
                          {q.brands_named.length > 6 ? ` and ${q.brands_named.length - 6} more` : ''}
                        </span>
                      )}
                    </span>
                    {q.ai_search_volume !== null && (
                      <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground @md:block" title="How often this is asked of AI assistants a month (an estimate)">
                        {q.ai_search_volume.toLocaleString()} a month
                      </span>
                    )}
                    {tracked ? (
                      <span className="w-12 shrink-0 text-right text-[11px] text-muted-foreground">Asked</span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        data-seo-explore-add=""
                        className="h-7 w-12 shrink-0 px-2 text-xs"
                        disabled={adding !== null}
                        title="Ask this in every check"
                        onClick={() => void add(q)}
                      >
                        {adding === q.question ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Add'}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
