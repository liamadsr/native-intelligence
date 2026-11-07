'use client'

/**
 * One eval case, as a full page.
 *
 * A case is a synthetic meeting plus a grading contract. The TRANSCRIPT section
 * is the meeting as the agent will actually receive it: timestamped,
 * speaker-labelled, inline editable, with a divider at every frozen chunk
 * boundary. EXPECTED OUTCOMES is the contract — the `expected` block as grouped
 * cards, each with its own gate/soft toggle.
 *
 * SHAPE. The house full-page editor: `EntityDetailHeader` (breadcrumb back to
 * the suite, inline name, ⋯ menu, polarity pill, Play / Save) over a centered
 * `ScrollArea` column. The editor is EXPLICIT-SAVE, as it always has been — the
 * name in the header is the draft, written by Save and not autosaved.
 *
 * WHY THE CHUNK DIVIDERS ARE THE POINT OF THE TRANSCRIPT. A live trial does not
 * hand the agent a transcript; it hands it eleven windows, one at a time, and
 * every expectation keyed to a chunk index (`after_chunk`, `no_nudge_windows`)
 * is written against those boundaries. The boundaries are frozen on the case
 * (`chunks[].segment_indices`, computed by `freezeChunks` from the script's own
 * `t_ms`), so an author writing "the agent should push back by chunk 3" needs
 * to see where chunk 3 ends. Without the dividers that number is a guess.
 *
 * WHY THE DIVIDERS GO STALE ON EDIT AND SAY SO. Chunks are recomputed
 * server-side by `updateEvalCase` whenever the script changes — the editor
 * cannot re-freeze locally without reimplementing the gate a third time. So a
 * dirty script draws its dividers greyed with a "recomputed on save" note
 * rather than drawing boundaries that are now a lie. Lying dividers would be
 * worse than none: they are load-bearing for the chunk-indexed expectations
 * right beside them.
 *
 * WHY POLARITY AND MODES ARE EDITABLE HERE. Both QUALIFY every expectation
 * below rather than sitting beside them: a negative control's empty proposals
 * list means the exact opposite of a positive case's, and a case that does not
 * run in `live` is never graded on nudges. `UpdateCaseSchema` takes both and
 * they are edited in place.
 */

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { EntityDetailHeader } from '@/components/views/entity-detail-header'
import {
  APPEND_GAP_MS,
  defaultSelfSpeaker,
  parseTranscriptText,
  toParticipants,
  toScript,
  type ParsedTranscript,
} from '@/lib/evals/parse-transcript'
import type {
  EvalCaseRow,
  EvalMode,
  EvalParticipant,
  EvalPolarity,
  ExpectedGist,
  ExpectedNudge,
  ExpectedOutcomes,
  ExpectedProposal,
  RubricItem,
  ScriptSegment,
  Severity,
} from '@/lib/evals/types'
import { EVAL_MODES } from '@/lib/evals/types'
import { cn } from '@/lib/utils'
import { ClipboardPaste, Loader2, Play, Plus, Trash2 } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { toast } from 'sonner'
import { truncateBreadcrumbTitle } from '../views/detail-breadcrumb-header'
import { ViewHeader } from '../views/view-header'
import { deleteCase, errorMessage, fetchCase, startRun } from './api'
import { MODE_LABELS } from './ui-helpers'

// ============================================================
// Saving
//
// `fetchCase`, `deleteCase` and `startRun` come from the shared `./api` layer.
// The PATCH below is this screen's alone — it is the only screen that writes a
// case — so it lives here rather than widening that surface for one caller.
// ============================================================

/** Exactly the keys `UpdateCaseSchema` accepts. It is `.strict()`, so an
 *  unknown key 400s the whole edit rather than being dropped quietly. */
export interface SaveCaseBody {
  name?: string
  script?: ScriptSegment[]
  expected?: ExpectedOutcomes
  /** Only ever sent after a paste. The script carries `local_1`/`remote_2`,
   *  and this is the only place the pasted DISPLAY names survive — without it
   *  the agent is shown a meeting between two anonymous labels when the
   *  transcript said `Dana` and `Priya`. */
  participants?: EvalParticipant[]
  polarity?: EvalPolarity
  modes?: EvalMode[]
}

export async function saveEvalCase(
  caseId: string,
  body: SaveCaseBody,
): Promise<EvalCaseRow> {
  const res = await fetch(`/api/account/evals/cases/${caseId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let message = `Could not save this case (${res.status})`
    try {
      const parsed = (await res.json()) as { error?: unknown }
      if (typeof parsed.error === 'string') message = parsed.error
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message)
  }
  const parsed = (await res.json()) as { case: EvalCaseRow }
  return parsed.case
}

// ============================================================
// Formatting
// ============================================================

/** `t_ms` as `mm:ss`. Tabular figures everywhere it is rendered, so the
 *  colons line up down the left rail of the transcript. */
export function formatTimestamp(tMs: number): string {
  const total = Math.max(0, Math.floor(tMs / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * Which segment indices END a chunk. A divider is drawn AFTER that segment,
 * which is where the flush actually happened.
 *
 * Built from `segment_indices` rather than `t_ms_end` because a script may
 * carry two segments at the same offset, and the segment list is what the
 * freezer itself keyed the window on.
 */
export function chunkBoundaries(
  chunks: { index: number; segment_indices: number[] }[],
): Map<number, number> {
  const byLastSegment = new Map<number, number>()
  for (const chunk of chunks) {
    const last = chunk.segment_indices[chunk.segment_indices.length - 1]
    if (typeof last === 'number') byLastSegment.set(last, chunk.index)
  }
  return byLastSegment
}

/** The self speaker, from the mic stream — the label rendered in the accent. */
export function selfSpeakers(script: ScriptSegment[]): Set<string> {
  const speakers = new Set<string>()
  for (const segment of script) {
    if (segment.stream === 'mic') speakers.add(segment.speaker)
  }
  return speakers
}

// ============================================================
// Expected-outcome group plumbing
// ============================================================

/**
 * The four list groups, in the order the spec names them. Each is a list of
 * items with a `key`, one prose field, and a severity — which is the whole
 * reason they can share one renderer instead of four.
 *
 * `summary` and `tool_usage` are single strings, not lists, so they get their
 * own block below rather than being forced into this shape.
 */
type GroupId = 'proposals' | 'forbidden_proposals' | 'nudges' | 'rubric'

const GROUP_LABELS: Record<GroupId, string> = {
  proposals: 'Proposals',
  forbidden_proposals: 'Forbidden',
  nudges: 'Nudges',
  rubric: 'Rubric',
}

/** What the prose field on each group's item is called, in words. */
const GROUP_PROSE_LABELS: Record<GroupId, string> = {
  proposals: 'What the agent should propose',
  forbidden_proposals: 'What must not appear',
  nudges: 'What the nudge should be about',
  rubric: 'The criterion',
}

const GROUP_EMPTY: Record<GroupId, string> = {
  proposals:
    'Nothing expected. A positive case with no proposals passes by expecting nothing.',
  forbidden_proposals: 'Nothing forbidden.',
  nudges: 'No nudges expected.',
  rubric: 'No free-form criteria.',
}

/** Severity when the author has not chosen one — matches the graders' own
 *  default (`severity ?? 'soft'`), so the toggle never shows a stricter rule
 *  than the run will apply. */
const DEFAULT_SEVERITY: Severity = 'soft'

type AnyItem = ExpectedProposal | ExpectedGist | ExpectedNudge | RubricItem

function itemProse(group: GroupId, item: AnyItem): string {
  if (group === 'proposals') return (item as ExpectedProposal).gist
  if (group === 'forbidden_proposals') return (item as ExpectedGist).gist
  if (group === 'nudges') return (item as ExpectedNudge).about
  return (item as RubricItem).criterion
}

function withProse(group: GroupId, item: AnyItem, value: string): AnyItem {
  if (group === 'nudges') return { ...(item as ExpectedNudge), about: value }
  if (group === 'rubric') return { ...(item as RubricItem), criterion: value }
  return { ...(item as ExpectedProposal | ExpectedGist), gist: value }
}

function blankItem(group: GroupId, key: string): AnyItem {
  if (group === 'proposals') {
    return { key, entity_type: 'action', change_type: 'create', gist: '' }
  }
  if (group === 'nudges') return { key, about: '' }
  if (group === 'rubric') return { key, criterion: '' }
  return { key, gist: '' }
}

function readGroup(expected: ExpectedOutcomes, group: GroupId): AnyItem[] {
  const raw = expected[group]
  return Array.isArray(raw) ? (raw as AnyItem[]) : []
}

function writeGroup(
  expected: ExpectedOutcomes,
  group: GroupId,
  items: AnyItem[],
): ExpectedOutcomes {
  const next = { ...expected }
  if (items.length === 0) delete next[group]
  // Each branch is typed on its own because the four arrays are four
  // different element types — one cast over the union would let a rubric
  // item be written into `proposals`.
  else if (group === 'proposals') next.proposals = items as ExpectedProposal[]
  else if (group === 'forbidden_proposals')
    next.forbidden_proposals = items as ExpectedGist[]
  else if (group === 'nudges') next.nudges = items as ExpectedNudge[]
  else next.rubric = items as RubricItem[]
  return next
}

/** A key that cannot collide with one already in the group. The key is what
 *  the compare view joins runs on (`check_key`), so a duplicate would merge
 *  two different expectations into one column. */
export function nextItemKey(group: GroupId, items: AnyItem[]): string {
  const taken = new Set(items.map((item) => item.key))
  const stem =
    group === 'forbidden_proposals' ? 'forbidden' : group.replace(/s$/, '')
  for (let n = items.length + 1; ; n += 1) {
    const key = `${stem}_${n}`
    if (!taken.has(key)) return key
  }
}

// ============================================================
// Small controls
// ============================================================

/**
 * gate | soft. A two-option toggle group rather than a switch, because neither
 * value is the "off" position: a gate check failing fails the whole trial, a
 * soft one only moves the score, and a switch would make one of them read as
 * the absence of the other.
 */
function SeverityToggle({
  value,
  onChange,
}: {
  value: Severity
  onChange: (next: Severity) => void
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as Severity)
      }}
      className="shrink-0"
    >
      <ToggleGroupItem
        value="gate"
        aria-label="gate"
        className="h-6 px-2 text-[10px]"
      >
        gate
      </ToggleGroupItem>
      <ToggleGroupItem
        value="soft"
        aria-label="soft"
        className="h-6 px-2 text-[10px]"
      >
        soft
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

/** One expectation. Prose in a textarea, its severity, and a remove. */
function ExpectationRow({
  group,
  item,
  onChange,
  onRemove,
}: {
  group: GroupId
  item: AnyItem
  onChange: (next: AnyItem) => void
  onRemove: () => void
}) {
  const nudge = group === 'nudges' ? (item as ExpectedNudge) : null
  const proposal = group === 'proposals' ? (item as ExpectedProposal) : null
  return (
    <div className="group/row border-border space-y-2 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[10px]">
          {item.key}
        </span>
        <SeverityToggle
          value={item.severity ?? DEFAULT_SEVERITY}
          onChange={(severity) => onChange({ ...item, severity })}
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={onRemove}
          aria-label={`Remove ${item.key}`}
          className="text-muted-foreground h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
      <Textarea
        aria-label={`${GROUP_PROSE_LABELS[group]} — ${item.key}`}
        value={itemProse(group, item)}
        onChange={(event) =>
          onChange(withProse(group, item, event.target.value))
        }
        placeholder={GROUP_PROSE_LABELS[group]}
        className="min-h-[52px] resize-y text-xs"
      />
      {proposal && (
        // entity_type / change_type are STRUCTURAL — the matcher filters on
        // them before the LLM ever sees a gist, so a typo here is a check
        // that can never pass. Two short inputs, not a select: the union is
        // the proposed-changes vocabulary and it grows server-side first.
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-muted-foreground text-xs">Entity type</Label>
            <Input
              aria-label={`Entity type — ${item.key}`}
              value={proposal.entity_type}
              onChange={(event) =>
                onChange({ ...proposal, entity_type: event.target.value })
              }
              placeholder="action"
              className="h-7 font-mono text-[11px]"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-muted-foreground text-xs">Change type</Label>
            <Input
              aria-label={`Change type — ${item.key}`}
              value={proposal.change_type}
              onChange={(event) =>
                onChange({ ...proposal, change_type: event.target.value })
              }
              placeholder="create"
              className="h-7 font-mono text-[11px]"
            />
          </div>
        </div>
      )}
      {nudge && (
        // The chunk window. Blank means "anywhere in the call", which is what
        // an author wants most of the time — so an empty input clears the key
        // rather than writing a 0 the grader would read as "before chunk 0".
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-muted-foreground text-xs">After chunk</Label>
            <ChunkInput
              label={`After chunk — ${item.key}`}
              value={nudge.after_chunk}
              onChange={(after_chunk) => onChange({ ...nudge, after_chunk })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-muted-foreground text-xs">
              Before chunk
            </Label>
            <ChunkInput
              label={`Before chunk — ${item.key}`}
              value={nudge.before_chunk}
              onChange={(before_chunk) => onChange({ ...nudge, before_chunk })}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function ChunkInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: number | undefined
  onChange: (next: number | undefined) => void
}) {
  return (
    <Input
      aria-label={label}
      inputMode="numeric"
      value={value === undefined ? '' : String(value)}
      onChange={(event) => {
        const raw = event.target.value.trim()
        if (raw === '') return onChange(undefined)
        const parsed = Number(raw)
        if (Number.isInteger(parsed) && parsed >= 0) onChange(parsed)
      }}
      placeholder="any"
      className="h-7 text-[11px] tabular-nums"
    />
  )
}

function ExpectationGroup({
  group,
  expected,
  onChange,
}: {
  group: GroupId
  expected: ExpectedOutcomes
  onChange: (next: ExpectedOutcomes) => void
}) {
  const items = readGroup(expected, group)
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">
          {GROUP_LABELS[group]}
          {items.length > 0 && (
            <span className="text-muted-foreground ml-1.5 text-[10px] font-normal tabular-nums">
              {items.length}
            </span>
          )}
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground h-7 gap-1.5 text-xs"
          onClick={() =>
            onChange(
              writeGroup(expected, group, [
                ...items,
                blankItem(group, nextItemKey(group, items)),
              ]),
            )
          }
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>
      {items.length === 0 ? (
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          {GROUP_EMPTY[group]}
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((item, index) => (
            <ExpectationRow
              key={item.key}
              group={group}
              item={item}
              onChange={(next) =>
                onChange(
                  writeGroup(
                    expected,
                    group,
                    items.map((existing, i) => (i === index ? next : existing)),
                  ),
                )
              }
              onRemove={() =>
                onChange(
                  writeGroup(
                    expected,
                    group,
                    items.filter((_, i) => i !== index),
                  ),
                )
              }
            />
          ))}
        </div>
      )}
    </section>
  )
}

/** Summary and Tool usage — one prose criterion each, judged free-form. */
function ProseExpectation({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: string | undefined
  onChange: (next: string | undefined) => void
}) {
  return (
    <section className="space-y-2">
      <p className="text-xs font-medium">{label}</p>
      <Textarea
        aria-label={label}
        value={value ?? ''}
        // An empty string is DELETED, not stored: `expected.summary = ''` is a
        // judge criterion of "" that scores every summary against nothing.
        onChange={(event) =>
          onChange(
            event.target.value.trim() === '' ? undefined : event.target.value,
          )
        }
        placeholder={hint}
        className="min-h-[52px] resize-y text-xs"
      />
    </section>
  )
}

// ============================================================
// The transcript section
// ============================================================

function TranscriptSegment({
  segment,
  index,
  isSelf,
  onChange,
  onRemove,
}: {
  segment: ScriptSegment
  index: number
  isSelf: boolean
  onChange: (next: ScriptSegment) => void
  onRemove: () => void
}) {
  /**
   * The `field-sizing-content` fallback, and nothing more: on an engine that
   * supports it the measured `scrollHeight` already equals the rendered height
   * and this writes back the value the browser chose. On one that does not
   * (Safari before 18.4, jsdom), it is the only thing standing between a long
   * line and a clipped one. Guarded on `field-sizing` being unsupported so the
   * common path stays purely declarative.
   */
  const textRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = textRef.current
    if (!el) return
    if (typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content'))
      return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [segment.text])

  return (
    <div className="group/row hover:bg-muted/40 grid grid-cols-[3.5rem_5rem_1fr_1.5rem] items-start gap-2 rounded-md px-1 py-1 transition-colors">
      <span className="text-muted-foreground pt-1.5 text-right font-mono text-[10px] tabular-nums">
        {formatTimestamp(segment.t_ms)}
      </span>
      <span
        className={cn(
          'truncate pt-1.5 font-mono text-[11px]',
          isSelf ? 'text-primary' : 'text-muted-foreground',
        )}
        title={`${segment.speaker} · ${segment.stream}`}
      >
        {segment.speaker}
      </span>
      {/* A transcript line is prose of unknown length, and the house Textarea
          floors at `min-h-[60px]` — which at this column width showed about one
          and a third lines and cut the rest off. `field-sizing-content` (Tailwind
          4) makes the control grow with its own value, so `min-h-0` + `rows={1}`
          is a ONE-line floor rather than a fixed height, and `resize-none`
          removes a manual handle that would fight it. The on-input sync below is
          the fallback for engines without `field-sizing`. */}
      <Textarea
        ref={textRef}
        aria-label={`Line ${index + 1} — ${segment.speaker}`}
        value={segment.text}
        onChange={(event) => onChange({ ...segment, text: event.target.value })}
        rows={1}
        className="field-sizing-content min-h-0 resize-none py-1.5 text-xs leading-relaxed"
      />
      <Button
        variant="ghost"
        size="icon"
        onClick={onRemove}
        aria-label={`Remove line ${index + 1}`}
        className="text-muted-foreground mt-0.5 h-6 w-6 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
      >
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  )
}

/**
 * The frozen flush boundary. Stale (`recomputed`) once the script is dirty —
 * see the file header for why a stale divider is drawn greyed rather than
 * moved or hidden.
 */
function ChunkDivider({ index, stale }: { index: number; stale: boolean }) {
  return (
    <div className="text-muted-foreground flex items-center gap-2 px-1 py-1.5 text-[10px] tracking-wide uppercase">
      <Separator className={cn('flex-1', stale && 'opacity-40')} />
      <span
        className={cn(
          'shrink-0 tabular-nums',
          stale && 'text-muted-foreground/50',
        )}
      >
        flush {index + 1}
        {stale ? ' · recomputed on save' : ''}
      </span>
      <Separator className={cn('flex-1', stale && 'opacity-40')} />
    </div>
  )
}

// ============================================================
// Pasting a real transcript
// ============================================================

/**
 * The paste dialog.
 *
 * WHY THIS EXISTS. A case is only as real as its meeting, and the most real
 * meeting available is one that already happened — which the HUD's Copy button
 * and the stored transcript both already hand you. Retyping that into `Add
 * line` is the difference between testing against real calls and testing
 * against what someone imagined a real call sounds like.
 *
 * WHY "YOU ARE" IS A REQUIRED CHOICE AND NOT A GUESS. The parsed transcript
 * carries display names — `You`, `Remote 1`, `Dana` — and the script needs
 * speaker LABELS, because eval captures are written `capture_mode='desktop_dual'`
 * and self-binding only ever accepts one `local_1` on the mic stream (see
 * `create-case.ts` `selfSpeakerLabel`). Which pasted name is the owner's own
 * microphone is not recoverable from the text: `Dana` could be either side. So
 * the picker asks, defaulted to the one the HUD would have written for the
 * local mic. `Nobody` is a real answer — a transcript of a call the owner was
 * not on grades as a meeting with no self, and guessing one would bind the
 * owner's member row to a stranger's voice.
 */
function PasteTranscriptDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImport: (parsed: ParsedTranscript, self: string | null, mode: 'append' | 'replace') => void
}) {
  const [raw, setRaw] = useState('')
  const [self, setSelf] = useState<string | null>(null)
  /** Whether the picker has been touched. Until it is, the selection tracks
   *  the default as the paste changes — a person who pastes, then pastes
   *  something else, should not be left pointing at a speaker that is gone. */
  const [selfTouched, setSelfTouched] = useState(false)

  const parsed = useMemo(() => parseTranscriptText(raw), [raw])
  const suggested = useMemo(
    () => defaultSelfSpeaker(parsed.speakers),
    [parsed.speakers],
  )
  const effectiveSelf =
    selfTouched && (self === null || parsed.speakers.includes(self)) ? self : suggested

  // Reset on every open, so a second paste never starts inside the first one's
  // text.
  useEffect(() => {
    if (open) {
      setRaw('')
      setSelf(null)
      setSelfTouched(false)
    }
  }, [open])

  const ready = parsed.lines.length > 0
  const nothingParsed = raw.trim().length > 0 && !ready

  const submit = (mode: 'append' | 'replace') => {
    if (!ready) return
    onImport(parsed, effectiveSelf, mode)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Paste transcript</DialogTitle>
          <DialogDescription>
            Paste a transcript copied from a real call — the HUD&apos;s Copy button, or a
            stored transcript.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Transcript</Label>
            <Textarea
              aria-label="Transcript to paste"
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
              rows={10}
              placeholder={
                'Paste lines like "You: Let\'s start with the roadmap" or "[remote_1] Sure, what\'s the priority?"'
              }
              className="resize-y font-mono text-xs"
            />
            {nothingParsed ? (
              <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
                <p role="alert">
                  Nothing looked like a transcript line. Expected &quot;Speaker: text&quot; or
                  &quot;[speaker] text&quot;.
                </p>
              </div>
            ) : (
              <p className="text-muted-foreground text-[11px] tabular-nums">
                {ready
                  ? `${parsed.lines.length} line${parsed.lines.length === 1 ? '' : 's'} · ${
                      parsed.speakers.length
                    } speaker${parsed.speakers.length === 1 ? '' : 's'}`
                  : 'Nothing pasted yet.'}
              </p>
            )}
          </div>

          {ready && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">You are</Label>
              <ToggleGroup
                type="single"
                value={effectiveSelf ?? '__nobody__'}
                onValueChange={(value) => {
                  if (!value) return
                  setSelfTouched(true)
                  setSelf(value === '__nobody__' ? null : value)
                }}
                className="flex flex-wrap justify-start gap-1"
              >
                {parsed.speakers.map((speaker) => (
                  <ToggleGroupItem
                    key={speaker}
                    value={speaker}
                    aria-label={speaker}
                    className="h-7 px-2.5 text-xs"
                  >
                    {speaker}
                  </ToggleGroupItem>
                ))}
                <ToggleGroupItem
                  value="__nobody__"
                  aria-label="Nobody"
                  className="h-7 px-2.5 text-xs"
                >
                  Nobody
                </ToggleGroupItem>
              </ToggleGroup>
              <p className="text-muted-foreground text-[11px]">
                Lines from you go to the mic stream; everyone else is the other side of the
                call.
              </p>
            </div>
          )}

          {parsed.problems.length > 0 && ready && (
            <p className="text-muted-foreground text-[11px]">
              {parsed.problems.length} line
              {parsed.problems.length === 1 ? '' : 's'} skipped: {parsed.problems[0]}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!ready}
            onClick={() => submit('append')}
          >
            Append
          </Button>
          <Button size="sm" disabled={!ready} onClick={() => submit('replace')}>
            Replace transcript
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ============================================================
// The page
// ============================================================

export function EvalCasePage({
  caseId,
  suiteName,
  onBack,
  onCaseNameLoaded,
  onSaved,
}: {
  caseId: string
  /** The breadcrumb crumb. A deep link arrives before the suite is known, so
   *  the header falls back to a generic label rather than an empty crumb. */
  suiteName?: string
  onBack: () => void
  /** Deep links arrive with a placeholder name; called once the page knows the
   *  real one so the caller can refresh the history entry/label. */
  onCaseNameLoaded?: (id: string, name: string) => void
  /** The saved row, so a caller can refresh counts without a full refetch. */
  onSaved?: (saved: EvalCaseRow) => void
}) {
  const [loaded, setLoaded] = useState<EvalCaseRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Which mode is starting, not a bare boolean: two run gestures exist and only
  // the pressed one should spin.
  const [running, setRunning] = useState<EvalMode | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)

  // The draft. Kept as separate pieces of state rather than a cloned row, so a
  // save that returns a server-recomputed `chunks` can replace the whole row
  // without stomping a field the user is mid-edit in.
  const [name, setName] = useState('')
  const [script, setScript] = useState<ScriptSegment[]>([])
  const [expected, setExpected] = useState<ExpectedOutcomes>({})
  const [polarity, setPolarity] = useState<EvalPolarity>('positive')
  const [modes, setModes] = useState<EvalMode[]>([])
  /**
   * Participants, initialised from the loaded case and sent whole on Save.
   *
   * `participants` on a PATCH REPLACES the capture's list — that is the
   * documented contract and the only way to remove a speaker — so this draft
   * has to start as the FULL loaded list, not as null. Append merges the pasted
   * speakers onto it; Replace swaps it outright; an ordinary Save sends it only
   * when it differs from what loaded, so a save that touched nothing else does
   * not rewrite the capture's participant rows.
   */
  const [participants, setParticipants] = useState<EvalParticipant[]>([])
  /** What the server last returned, to diff the draft against on Save. */
  const [loadedParticipants, setLoadedParticipants] = useState<EvalParticipant[]>([])

  const hydrate = useCallback((row: EvalCaseRow, loadedList: EvalParticipant[]) => {
    setLoaded(row)
    setName(row.name)
    setScript(row.script ?? [])
    setExpected(row.expected ?? {})
    setPolarity(row.polarity ?? 'positive')
    setModes(row.modes ?? [])
    setParticipants(loadedList)
    setLoadedParticipants(loadedList)
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    // Drop the previous case BEFORE the fetch, the way run-page and
    // suite-detail do. Without this a failed load for a new id leaves the old
    // row (and its draft) mounted under the new id, and the next Save PATCHes
    // the old case's script and grading contract onto the new one.
    setLoaded(null)
    setName('')
    setScript([])
    setExpected({})
    setPolarity('positive')
    setModes([])
    setParticipants([])
    setLoadedParticipants([])
    void (async () => {
      try {
        const { case: row, participants: loadedList } = await fetchCase(caseId)
        if (cancelled) return
        hydrate(row, loadedList)
      } catch (err) {
        if (cancelled) return
        setError(errorMessage(err, 'Could not load this case'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [caseId, hydrate])

  /**
   * Report the loaded name exactly ONCE PER VALUE, from a ref'd callback — the
   * suite-detail request-storm contract. The parent's `onCaseNameLoaded` is an
   * inline arrow that calls `navigate`, so listing it in the load effect's deps
   * would close a load → report → re-render → load circuit that spins as fast
   * as the network answers.
   */
  const onCaseNameLoadedRef = useRef(onCaseNameLoaded)
  onCaseNameLoadedRef.current = onCaseNameLoaded
  const reportedNameRef = useRef<string | null>(null)
  const loadedName = loaded?.name
  useEffect(() => {
    if (!loadedName || reportedNameRef.current === loadedName) return
    reportedNameRef.current = loadedName
    onCaseNameLoadedRef.current?.(caseId, loadedName)
  }, [caseId, loadedName])

  const scriptDirty = useMemo(
    () =>
      loaded !== null &&
      JSON.stringify(script) !== JSON.stringify(loaded.script ?? []),
    [script, loaded],
  )
  const participantsDirty = useMemo(
    () => JSON.stringify(participants) !== JSON.stringify(loadedParticipants),
    [participants, loadedParticipants],
  )
  const dirty = useMemo(() => {
    if (!loaded) return false
    return (
      scriptDirty ||
      participantsDirty ||
      name !== loaded.name ||
      polarity !== (loaded.polarity ?? 'positive') ||
      JSON.stringify(modes) !== JSON.stringify(loaded.modes ?? []) ||
      JSON.stringify(expected) !== JSON.stringify(loaded.expected ?? {})
    )
  }, [loaded, scriptDirty, participantsDirty, name, expected, polarity, modes])

  const boundaries = useMemo(
    () => chunkBoundaries(loaded?.chunks ?? []),
    [loaded],
  )
  const selves = useMemo(() => selfSpeakers(script), [script])

  const addSegment = useCallback(() => {
    setScript((prev) => {
      const last = prev[prev.length - 1]
      return [
        ...prev,
        {
          // +4s, past the gate's 3s silence rule, so a line appended by hand
          // lands in a NEW flush window rather than silently extending the
          // last one — the cadence a real turn boundary produces.
          t_ms: last ? last.t_ms + 4000 : 0,
          speaker: last?.speaker ?? 'Speaker',
          stream: last?.stream === 'mic' ? 'system' : 'mic',
          text: '',
        },
      ]
    })
  }, [])

  /**
   * Land a pasted transcript in the draft.
   *
   * REPLACE is the simple half: the parsed script becomes the script, and its
   * participants become the participant list.
   *
   * APPEND has to reconcile two label spaces. The pasted speakers were labelled
   * against an empty script, so a second `remote_1` would silently merge a new
   * person into an existing one. The existing labels are collected first and
   * handed to the parser as `takenLabels`, with one deliberate exception: if the
   * script already has a `local_1` on the mic and the paste also names a self,
   * that IS the same person — the case owner — so `local_1` is reused rather
   * than being pushed to `remote_N`.
   *
   * The new lines start a full turn gap after the last existing one, so the
   * seam is a flush boundary rather than a window spanning the join.
   *
   * Neither branch saves. Both just mark the draft dirty, exactly as typing
   * does, and the existing PATCH re-freezes the chunks on Save.
   */
  const importTranscript = useCallback(
    (parsed: ParsedTranscript, self: string | null, mode: 'append' | 'replace') => {
      if (parsed.lines.length === 0) return

      if (mode === 'replace') {
        setScript(toScript(parsed, self))
        setParticipants(toParticipants(parsed, self))
      } else {
        // The existing labels, so a pasted `remote_1` does not silently merge
        // into a different person already in the script. `local_1` passing
        // through this set is harmless and intended: `assignLabels` only ever
        // draws `remote_N` from it, so a pasted self reuses the script's
        // existing `local_1` — which is right, because a script can only have
        // one mic speaker and it is the same person either way.
        const taken = new Set(script.map((segment) => segment.speaker))
        const last = script[script.length - 1]
        const startMs = last ? last.t_ms + APPEND_GAP_MS : 0
        const added = toScript(parsed, self, { startMs, takenLabels: taken })
        setScript([...script, ...added])
        // The FULL list: the PATCH replaces wholesale, so Append has to send
        // the speakers already in the case alongside the pasted ones or they
        // are deleted while the script still carries their lines.
        setParticipants((prev) => {
          const next = toParticipants(parsed, self, { takenLabels: taken })
          const merged = [...prev]
          for (const participant of next) {
            const at = merged.findIndex((p) => p.speaker_label === participant.speaker_label)
            if (at < 0) merged.push(participant)
          }
          return merged
        })
      }

      toast.success(
        `Imported ${parsed.lines.length} line${parsed.lines.length === 1 ? '' : 's'} from ${
          parsed.speakers.length
        } speaker${parsed.speakers.length === 1 ? '' : 's'}`,
      )
    },
    [script],
  )

  const save = useCallback(async () => {
    if (!loaded) return
    setSaving(true)
    setError(null)
    try {
      const saved = await saveEvalCase(caseId, {
        name: name !== loaded.name ? name : undefined,
        script: scriptDirty ? script : undefined,
        expected,
        // Sent only when the draft differs from what loaded: this REPLACES the
        // capture's list, so an unchanged save should not rewrite it.
        participants: participantsDirty ? participants : undefined,
        // `modes` is NOT NULL with a two-element default, and the schema floors
        // it at one entry — so an empty draft is sent as `undefined` (leave it
        // alone) rather than as `[]`, which would 400 the whole save.
        polarity,
        modes: modes.length > 0 ? modes : undefined,
      })
      const recomputed = scriptDirty
      // The PATCH answers with the case row only; participants live on the
      // capture. What we just sent IS the server's list now, so it becomes the
      // new baseline — re-fetching only to learn that back would be a round
      // trip for a value we already hold.
      hydrate(saved, participants)
      onSaved?.(saved)
      reportedNameRef.current = saved.name
      onCaseNameLoadedRef.current?.(caseId, saved.name)
      toast.success(
        recomputed ? 'Saved. Flush boundaries recomputed.' : 'Saved.',
      )
    } catch (err) {
      setError(errorMessage(err, 'Could not save this case'))
    } finally {
      setSaving(false)
    }
  }, [
    caseId,
    loaded,
    name,
    script,
    scriptDirty,
    expected,
    participants,
    participantsDirty,
    polarity,
    modes,
    hydrate,
    onSaved,
  ])

  /**
   * Run just THIS case, in one mode.
   *
   * Both modes matter from here. This screen is where nudge and chunk-window
   * expectations are authored, and those are graded ONLY in live — without this
   * the only way to exercise them is running the whole suite, the most
   * expensive gesture on offer.
   *
   * `dirty` guards both: replaying a case whose script has unsaved edits would
   * grade the saved version and report it under the edited one.
   */
  const run = useCallback(
    async (mode: EvalMode) => {
      if (!loaded) return
      setRunning(mode)
      setError(null)
      try {
        const { adopted } = await startRun({
          suite_id: loaded.suite_id,
          mode,
          case_ids: [caseId],
        })
        toast.success(
          adopted
            ? `This suite already has a ${MODE_LABELS[mode].toLowerCase()} run going — following that one.`
            : `${MODE_LABELS[mode]} run queued.`,
        )
      } catch (err) {
        setError(errorMessage(err, 'Could not start the run'))
      } finally {
        setRunning(null)
      }
    },
    [caseId, loaded],
  )

  const removeCase = useCallback(async () => {
    setDeleting(true)
    try {
      await deleteCase(caseId)
      onBack()
    } catch (err) {
      setError(errorMessage(err, 'Could not delete this case'))
      setConfirmDelete(false)
    } finally {
      setDeleting(false)
    }
  }, [caseId, onBack])

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <ViewHeader title="Case" />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
        </div>
      </div>
    )
  }

  if (!loaded) {
    return (
      <div className="flex h-full flex-col">
        <ViewHeader
          title="Case"
          actions={
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={onBack}
            >
              Back to suite
            </Button>
          }
        />
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6">
          <p className="text-muted-foreground text-sm">
            {error ?? 'Case not found'}
          </p>
          <Button variant="outline" size="sm" onClick={onBack}>
            Close
          </Button>
        </div>
      </div>
    )
  }

  const liveDeclared = modes.includes('live')
  const batchDeclared = modes.includes('batch')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EntityDetailHeader
        // A suite's name is a sentence ("Smoke 3 — discovery call (self
        // bound)"), and the whole thing in the crumb starved the case name
        // beside it. Shortened by the same helper the views breadcrumb uses,
        // with the full name kept in the crumb's tooltip.
        viewTitle={truncateBreadcrumbTitle(suiteName ?? 'Suite')}
        viewTitleFull={suiteName ?? 'Suite'}
        onBack={onBack}
        name={name}
        onNameChange={setName}
        namePlaceholder="Untitled case"
        menuItems={
          <>
            <DropdownMenuItem
              disabled={running !== null || dirty || !batchDeclared}
              onClick={() => void run('batch')}
            >
              <Play className="mr-2 h-3.5 w-3.5" />
              Run batch on this case
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete case
            </DropdownMenuItem>
          </>
        }
        // A read-only mirror of the Polarity toggle below: it qualifies every
        // expectation on the page, so it is worth saying in the header too.
        statusPill={
          <span
            className={cn(
              'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium',
              polarity === 'negative'
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                : 'border-border bg-muted/40 text-muted-foreground',
            )}
          >
            {polarity === 'negative' ? 'Negative control' : 'Positive'}
          </span>
        }
        actions={
          <>
            {/* Live at instant. Disabled, with the reason, when the case does
                not declare the live mode rather than hidden: a case with nudge
                expectations and no live mode is an authoring mistake the greyed
                button makes visible. */}
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => void run('live')}
              disabled={running !== null || dirty || !liveDeclared}
              title={
                !liveDeclared
                  ? 'This case does not run in live mode — add it below to replay the script chunk by chunk.'
                  : dirty
                    ? 'Save first — a replay grades the stored script.'
                    : 'Replay this case chunk by chunk, the way a real call arrives.'
              }
            >
              {running === 'live' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Play className="h-3 w-3" />
              )}
              Play this case
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => void save()}
              disabled={saving || !dirty}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </>
        }
      />

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-[760px] space-y-6 px-5 pt-2 pb-24">
          {error && (
            <div className="space-y-1 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
              <p role="alert">{error}</p>
            </div>
          )}

          {/* ── Details ── */}
          <div className="space-y-4">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Details
            </p>
            <div className="space-y-2">
              <Label className="text-muted-foreground text-xs">Polarity</Label>
              <ToggleGroup
                type="single"
                size="sm"
                value={polarity}
                onValueChange={(next) => {
                  if (next) setPolarity(next as EvalPolarity)
                }}
                className="justify-start"
                aria-label="Polarity"
              >
                <ToggleGroupItem
                  value="positive"
                  aria-label="positive"
                  className="text-xs"
                >
                  Positive
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="negative"
                  aria-label="negative"
                  className="text-xs"
                >
                  Negative control
                </ToggleGroupItem>
              </ToggleGroup>
              <p className="text-muted-foreground text-[11px]">
                A negative control expects the agent to stay quiet. It is what
                lets a suite catch a prompt getting more eager.
              </p>
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground text-xs">Modes</Label>
              <ToggleGroup
                type="multiple"
                size="sm"
                value={modes}
                onValueChange={(next) => {
                  // The last mode cannot be turned off: a case that runs in no
                  // mode is never graded by anything, and the schema floors the
                  // array at one entry, so the save would 400 anyway.
                  if (next.length === 0) return
                  // Keep the canonical order rather than click order, so two
                  // cases with the same modes look the same.
                  setModes(EVAL_MODES.filter((m) => next.includes(m)))
                }}
                className="justify-start"
                aria-label="Modes"
              >
                {EVAL_MODES.map((mode) => (
                  <ToggleGroupItem
                    key={mode}
                    value={mode}
                    aria-label={mode}
                    className="text-xs capitalize"
                  >
                    {mode}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <p className="text-muted-foreground text-[11px]">
                A case has to run in at least one mode. Nudge expectations are
                only graded in live.
              </p>
            </div>
          </div>

          {/* ── Transcript ── */}
          <div className="space-y-3">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                Transcript
              </p>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-[10px] tabular-nums">
                  {script.length} line{script.length === 1 ? '' : 's'} ·{' '}
                  {loaded.chunks?.length ?? 0} flush
                  {(loaded.chunks?.length ?? 0) === 1 ? '' : 'es'}
                </span>
                {/* Up here rather than beside `Add line`, because it is a
                    section-level gesture on the whole transcript (it can
                    replace all of it) while `Add line` extends the list. */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-6 gap-1.5 text-xs"
                  onClick={() => setPasteOpen(true)}
                >
                  <ClipboardPaste className="h-3.5 w-3.5" />
                  Paste transcript
                </Button>
              </div>
            </div>
            <div>
              {script.map((segment, index) => (
                <div key={index}>
                  <TranscriptSegment
                    segment={segment}
                    index={index}
                    isSelf={selves.has(segment.speaker)}
                    onChange={(next) =>
                      setScript((prev) =>
                        prev.map((existing, i) =>
                          i === index ? next : existing,
                        ),
                      )
                    }
                    onRemove={() =>
                      setScript((prev) => prev.filter((_, i) => i !== index))
                    }
                  />
                  {boundaries.has(index) && (
                    <ChunkDivider
                      index={boundaries.get(index) as number}
                      stale={scriptDirty}
                    />
                  )}
                </div>
              ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground h-7 gap-1.5 text-xs"
              onClick={addSegment}
            >
              <Plus className="h-3.5 w-3.5" />
              Add line
            </Button>
          </div>

          {/* ── Expected outcomes ── */}
          <div className="space-y-5">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Expected outcomes
            </p>
            <ExpectationGroup
              group="proposals"
              expected={expected}
              onChange={setExpected}
            />
            <ExpectationGroup
              group="forbidden_proposals"
              expected={expected}
              onChange={setExpected}
            />
            <ProseExpectation
              label="Goal"
              hint="The goal of the call, in your words. Each trial sets it as the meeting goal, and the nudges are judged against it."
              value={expected.goal}
              onChange={(goal) => setExpected((prev) => ({ ...prev, goal }))}
            />
            <ExpectationGroup
              group="nudges"
              expected={expected}
              onChange={setExpected}
            />
            <ProseExpectation
              label="Summary"
              hint="What the summary has to get right."
              value={expected.summary}
              onChange={(summary) =>
                setExpected((prev) => ({ ...prev, summary }))
              }
            />
            <ProseExpectation
              label="Tools"
              hint="How the agent should have used its tools."
              value={expected.tool_usage}
              onChange={(tool_usage) =>
                setExpected((prev) => ({ ...prev, tool_usage }))
              }
            />
            <ExpectationGroup
              group="rubric"
              expected={expected}
              onChange={setExpected}
            />
          </div>
        </div>
      </ScrollArea>

      <PasteTranscriptDialog
        open={pasteOpen}
        onOpenChange={setPasteOpen}
        onImport={importTranscript}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete "${loaded.name}"?`}
        description="This deletes the case, its mock capture, and every trial recorded against it. It cannot be undone."
        busy={deleting}
        onConfirm={() => void removeCase()}
      />
    </div>
  )
}
