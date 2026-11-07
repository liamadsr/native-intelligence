'use client'

/**
 * Right-side configuration panel for the flow canvas. Renders the Trigger
 * config, one Action's config (selected by node id), or the loop's bot ("Its
 * bot", bots-v3 Phase 3: flow-bot-picker.tsx). An action's config is a
 * condition builder ("only run if …") above its per-type fields (HTTP request
 * or Run skill).
 */

import { useEffect, useState } from 'react'
import { Boxes, ChevronDown, Filter, Plus, Sparkles, Trash2, X, Zap, Globe, Laptop, Plug } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { FlowBotPicker } from './flow-bot-picker'
import { TEMPLATE_TOKENS } from '@/lib/flows/template'
import { useEditorConnections } from './use-editor-connections'
import {
  TOOL_CATEGORIES,
  getToolDefinition,
  REPORT_MODE_WRITE_ALLOWLIST,
} from '@/lib/ai/tool-registry'
import {
  PROJECT_STATUS_VALUES,
  INITIATIVE_STATUS_VALUES,
  MILESTONE_STATUS_VALUES,
} from '@/lib/flows/queries'
import {
  type AgentOption,
  type ConditionField,
  type ConditionOp,
  type EditorAction,
  type EditorCondition,
  type EditorRule,
  type EditorState,
  type EditorTrigger,
  type FlowBotOptions,
  type FlowEntityType,
  type FlowTriggerType,
  type Label as LabelType,
  type Member,
  type Project,
  type ScheduleCadence,
  type SelectedNode,
  type SkillOption,
  type Team,
  type WorkflowState,
  type PrTriggerState,
  PR_STATE_LABELS,
  CADENCE_LABELS,
  CONDITION_FIELD_LABELS,
  PRIORITY_LABELS,
  ENTITY_LABELS,
  NULLARY_OPS,
  SCALAR_OPS,
  TRIGGER_TYPE_LABELS,
  WEEKDAY_LABELS,
  newRule,
  ancestorSteps,
  parseToolInput,
} from './flow-types'

const STATUS_ENUMS: Record<Exclude<FlowEntityType, 'action'>, readonly string[]> = {
  project: PROJECT_STATUS_VALUES,
  initiative: INITIATIVE_STATUS_VALUES,
  milestone: MILESTONE_STATUS_VALUES,
}

interface FlowConfigPanelProps {
  selected: SelectedNode
  editor: EditorState
  setEditor: (e: EditorState) => void
  updateAction: (id: string, patch: Partial<EditorAction>) => void
  removeAction: (id: string) => void
  /** Someone else's loop (F1): the trigger and steps show read-only. The agent stays editable. */
  readOnly?: boolean
  teams: Team[]
  states: WorkflowState[]
  labels: LabelType[]
  members: Member[]
  projects: Project[]
  skills: SkillOption[]
  agents: AgentOption[]
  /** What "Its agent" offers (GET /api/account/flows/bots); null until loaded. */
  botOptions?: FlowBotOptions | null
  botOptionsLoading?: boolean
  /** A work agent was renamed or deleted in "Its agent": reload the options. */
  onBotsChanged?: () => void
  onClose: () => void
  /** Panel width in px (driven by the parent's resize hook). */
  width: number
  /** Pointer-down on the left-edge resize handle. */
  onResizeStart: (e: React.PointerEvent) => void
}

export function FlowConfigPanel({
  selected,
  editor,
  setEditor,
  updateAction,
  removeAction,
  readOnly = false,
  teams,
  states,
  labels,
  members,
  projects,
  skills,
  agents,
  botOptions = null,
  botOptionsLoading = false,
  onBotsChanged,
  onClose,
  width,
  onResizeStart,
}: FlowConfigPanelProps) {
  const isTrigger = selected?.kind === 'trigger'
  const isBot = selected?.kind === 'bot'
  const action =
    selected?.kind === 'action' ? editor.actions.find((a) => a.id === selected.id) ?? null : null
  const actionIndex = action ? editor.actions.findIndex((a) => a.id === action.id) : -1

  const setTrigger = (patch: Partial<EditorTrigger>) =>
    setEditor({ ...editor, trigger: { ...editor.trigger, ...patch } })

  return (
    <div
      className="relative flex h-full shrink-0 flex-col border-l border-border bg-card"
      style={{ width }}
    >
      {/* Left-edge resize handle */}
      <div
        onPointerDown={onResizeStart}
        className="group/handle absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
      >
        <div className="ml-[3px] h-full w-0.5 bg-transparent transition-colors group-hover/handle:bg-muted-foreground/40" />
      </div>
      {/* Panel header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          {isBot ? (
            <Boxes className="h-4 w-4 text-primary/80" />
          ) : isTrigger ? (
            <Zap className="h-4 w-4 text-amber-500/80" />
          ) : action?.type === 'run_skill' ? (
            <Sparkles className="h-4 w-4 text-violet-500/80" />
          ) : action?.type === 'run_agent' ? (
            <Boxes className="h-4 w-4 text-teal-500/80" />
          ) : action?.type === 'call_tool' ? (
            <Plug className="h-4 w-4 text-blue-500/80" />
          ) : action?.type === 'run_local_agent' ? (
            <Laptop className="h-4 w-4 text-teal-500/80" />
          ) : (
            <Globe className="h-4 w-4 text-blue-500/80" />
          )}
          <h2 className="text-sm font-semibold">
            {isBot ? 'Its agent' : isTrigger ? 'Configure trigger' : `Configure action ${actionIndex + 1}`}
          </h2>
        </div>
        <div className="flex items-center gap-1">
          {/* Per-action enable/disable — mirrors the whole-flow toggle. A
              disabled action (and its subtree) is skipped at fire time. */}
          {action && (
            <label className="mr-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Switch
                checked={action.enabled}
                disabled={readOnly}
                onCheckedChange={(v) => updateAction(action.id, { enabled: v })}
                className="data-[state=checked]:bg-emerald-500"
                aria-label={action.enabled ? 'Disable action' : 'Enable action'}
              />
              {action.enabled ? 'On' : 'Off'}
            </label>
          )}
          {action && !readOnly && editor.actions.length > 1 && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={() => removeAction(action.id)}
              aria-label="Delete action"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Panel body */}
      <div className="flex-1 overflow-y-auto p-4">
        {isBot ? (
          <FlowBotPicker
            editor={editor}
            setEditor={setEditor}
            options={botOptions}
            loading={botOptionsLoading}
            onBotsChanged={onBotsChanged}
          />
        ) : isTrigger || action ? (
          <>
            {readOnly && (
              <p data-flow-readonly-note="" className="mb-3 text-xs text-muted-foreground">
                Owned by {editor.ownedBy?.name ?? 'someone else'}: only they can change its trigger and steps.
              </p>
            )}
            {/* Native disabling: every input, select and button inside goes read-only. */}
            <fieldset disabled={readOnly} className="m-0 min-w-0 border-0 p-0">
              {isTrigger ? (
                <TriggerConfig editor={editor} setTrigger={setTrigger} setEditor={setEditor} teams={teams} states={states} />
              ) : action ? (
                <ActionConfig
                  action={action}
                  actions={editor.actions}
                  updateAction={updateAction}
                  trigger={editor.trigger}
                  states={states}
                  labels={labels}
                  members={members}
                  projects={projects}
                  skills={skills}
                  agents={agents}
                />
              ) : null}
            </fieldset>
          </>
        ) : null}
      </div>
    </div>
  )
}

// ── Trigger config ────────────────────────────────────────────

const TRIGGER_DESCRIPTIONS: Record<FlowTriggerType, string> = {
  entity_status_change: 'Fires when the selected entity moves into the target status.',
  schedule: 'Fires on a recurring schedule. Runs for the whole workspace — no team needed.',
  capture_processed:
    'Fires after a capture finishes batch processing. Runs for the whole workspace — no team needed.',
  calendar_event:
    'Fires before or after each occurrence of a recurring calendar event (e.g. 15 min before your weekly 1:1). Uses your synced calendar — no team needed.',
  pr_status_changed:
    "Fires when a GitHub pull request linked to one of the workspace's actions opens, merges or closes, in the repository you name. Only PRs from the repo's own people count.",
}

function TriggerConfig({
  editor,
  setTrigger,
  setEditor,
  teams,
  states,
}: {
  editor: EditorState
  setTrigger: (patch: Partial<EditorTrigger>) => void
  setEditor: (e: EditorState) => void
  teams: Team[]
  states: WorkflowState[]
}) {
  const t = editor.trigger
  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {TRIGGER_DESCRIPTIONS[t.kind]}
      </p>

      <Field label="Trigger type">
        <Select value={t.kind} onValueChange={(v) => setTrigger({ kind: v as FlowTriggerType })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(TRIGGER_TYPE_LABELS) as FlowTriggerType[]).map((k) => (
              <SelectItem key={k} value={k}>
                {TRIGGER_TYPE_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {t.kind === 'entity_status_change' && (
        <StatusChangeTriggerFields editor={editor} setTrigger={setTrigger} setEditor={setEditor} teams={teams} states={states} />
      )}
      {t.kind === 'schedule' && <ScheduleTriggerFields trigger={t} setTrigger={setTrigger} />}
      {t.kind === 'calendar_event' && (
        <CalendarEventTriggerFields trigger={t} setTrigger={setTrigger} />
      )}
      {t.kind === 'pr_status_changed' && (
        <>
          <Field label="Repository">
            <Input
              value={t.repo_full_name}
              onChange={(e) => setTrigger({ repo_full_name: e.target.value })}
              placeholder="owner/repo"
            />
          </Field>
          <Field label="When the pull request">
            <Select value={t.pr_state} onValueChange={(v) => setTrigger({ pr_state: v as PrTriggerState })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PR_STATE_LABELS) as PrTriggerState[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {PR_STATE_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </>
      )}
      {/* capture_processed carries no config beyond the type. */}
    </div>
  )
}

function StatusChangeTriggerFields({
  editor,
  setTrigger,
  setEditor,
  teams,
  states,
}: {
  editor: EditorState
  setTrigger: (patch: Partial<EditorTrigger>) => void
  setEditor: (e: EditorState) => void
  teams: Team[]
  states: WorkflowState[]
}) {
  const t = editor.trigger
  return (
    <>
      <Field label="Entity type">
        <Select
          value={t.entity_type}
          onValueChange={(v) =>
            // Clear status selections — the status namespace is type-specific.
            setTrigger({ entity_type: v as FlowEntityType, from_status_id: '__any__', to_status_id: '' })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="action">Action</SelectItem>
            <SelectItem value="project">Project</SelectItem>
            <SelectItem value="initiative">Initiative</SelectItem>
            <SelectItem value="milestone">Milestone</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field label="Team">
        <Select value={editor.team_id} onValueChange={(v) => setEditor({ ...editor, team_id: v })}>
          <SelectTrigger>
            <SelectValue placeholder="Pick a team" />
          </SelectTrigger>
          <SelectContent>
            {teams.map((tm) => (
              <SelectItem key={tm.id} value={tm.id}>
                {tm.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {t.entity_type !== 'action' && (
          <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-500">
            {ENTITY_LABELS[t.entity_type]}s are workspace-scoped — this flow fires for every{' '}
            {t.entity_type} in the workspace. The team here is for ownership and grouping only.
          </p>
        )}
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="From status">
          <Select value={t.from_status_id} onValueChange={(v) => setTrigger({ from_status_id: v })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__any__">Any status</SelectItem>
              <StatusOptions entityType={t.entity_type} states={states} />
            </SelectContent>
          </Select>
        </Field>
        <Field label="To status">
          <Select value={t.to_status_id} onValueChange={(v) => setTrigger({ to_status_id: v })}>
            <SelectTrigger>
              <SelectValue placeholder="Pick a status" />
            </SelectTrigger>
            <SelectContent>
              <StatusOptions entityType={t.entity_type} states={states} />
            </SelectContent>
          </Select>
        </Field>
      </div>
    </>
  )
}

function ScheduleTriggerFields({
  trigger,
  setTrigger,
}: {
  trigger: EditorTrigger
  setTrigger: (patch: Partial<EditorTrigger>) => void
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Cadence">
          <Select
            value={trigger.cadence}
            onValueChange={(v) => setTrigger({ cadence: v as ScheduleCadence })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(CADENCE_LABELS) as ScheduleCadence[]).map((c) => (
                <SelectItem key={c} value={c}>
                  {CADENCE_LABELS[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {trigger.cadence !== 'hourly' && (
          <Field label="Time">
            <Input
              type="time"
              value={trigger.time}
              onChange={(e) => setTrigger({ time: e.target.value })}
            />
          </Field>
        )}
      </div>

      {trigger.cadence === 'weekly' && (
        <Field label="Day of week">
          <Select
            value={String(trigger.weekday)}
            onValueChange={(v) => setTrigger({ weekday: Number.parseInt(v, 10) })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEEKDAY_LABELS.map((label, i) => (
                <SelectItem key={label} value={String(i)}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      <Field label="Timezone">
        <Input
          value={trigger.timezone}
          onChange={(e) => setTrigger({ timezone: e.target.value })}
          placeholder="America/Los_Angeles"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          IANA timezone name. Defaults to your browser&apos;s timezone.
        </p>
      </Field>
    </>
  )
}

function CalendarEventTriggerFields({
  trigger,
  setTrigger,
}: {
  trigger: EditorTrigger
  setTrigger: (patch: Partial<EditorTrigger>) => void
}) {
  // The stored value is a signed minute offset (negative = before). The UI
  // splits it into a magnitude + a before/after direction, which reads far more
  // naturally ("15 minutes before") than a signed integer.
  const stored = Number.isFinite(trigger.offset_minutes) ? trigger.offset_minutes : 0
  const magnitude = Math.abs(stored)
  const direction: 'before' | 'after' = stored > 0 ? 'after' : 'before'

  // The minutes field keeps its own text state so it can be CLEARED (empty
  // string) while typing — a controlled number input bound directly to a number
  // renders NaN when emptied. We commit a clamped number to the trigger, but let
  // the field show whatever the user is typing (including "").
  const [minutesText, setMinutesText] = useState(String(magnitude))

  // Re-sync the field when the stored value changes from OUTSIDE this component
  // (e.g. loading a different flow, or the direction toggle re-deriving it).
  useEffect(() => {
    setMinutesText(String(magnitude))
  }, [magnitude])

  const commit = (rawText: string, dir: 'before' | 'after') => {
    const parsed = Number.parseInt(rawText, 10)
    const safe = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1440) : 0
    setTrigger({ offset_minutes: dir === 'after' ? safe : -safe })
  }

  return (
    <>
      <Field label="Event title">
        <Input
          value={trigger.event_title}
          onChange={(e) => setTrigger({ event_title: e.target.value })}
          placeholder="Weekly 1:1"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Matches recurring events with this exact title in your synced calendar (case-insensitive).
        </p>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Minutes">
          <Input
            type="number"
            min={0}
            max={1440}
            value={minutesText}
            onChange={(e) => {
              setMinutesText(e.target.value)
              commit(e.target.value, direction)
            }}
            onBlur={() => setMinutesText(String(magnitude))}
          />
        </Field>
        <Field label="When">
          <Select value={direction} onValueChange={(v) => commit(minutesText, v as 'before' | 'after')}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="before">before the event</SelectItem>
              <SelectItem value="after">after the event</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">
        {magnitude === 0
          ? 'Fires right when the event starts.'
          : `Fires ${magnitude} minute${magnitude === 1 ? '' : 's'} ${direction} each occurrence.`}
      </p>
    </>
  )
}

function StatusOptions({
  entityType,
  states,
}: {
  entityType: FlowEntityType
  states: WorkflowState[]
}) {
  if (entityType === 'action') {
    return (
      <>
        {states.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.name}
          </SelectItem>
        ))}
      </>
    )
  }
  return (
    <>
      {STATUS_ENUMS[entityType].map((s) => (
        <SelectItem key={s} value={s}>
          {s.replace(/_/g, ' ')}
        </SelectItem>
      ))}
    </>
  )
}

// ── Action config ─────────────────────────────────────────────

function ActionConfig({
  action,
  actions,
  updateAction,
  trigger,
  states,
  labels,
  members,
  projects,
  skills,
  agents,
}: {
  action: EditorAction
  /** Every step of the loop (a connected-app step offers its ancestors' outputs). */
  actions: EditorAction[]
  updateAction: (id: string, patch: Partial<EditorAction>) => void
  trigger: EditorTrigger
  states: WorkflowState[]
  labels: LabelType[]
  members: Member[]
  projects: Project[]
  skills: SkillOption[]
  agents: AgentOption[]
}) {
  const patch = (p: Partial<EditorAction>) => updateAction(action.id, p)

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {action.type === 'run_skill'
          ? 'Runs one of your skills headlessly and delivers its output.'
          : action.type === 'run_agent'
            ? 'Dispatches a coding agent in a sandbox to work on a repo and open a pull request.'
            : action.type === 'archive_capture'
              ? 'Archives the capture that triggered this flow — a soft delete you can restore. Only meaningful on a "capture processed" flow.'
              : action.type === 'call_tool'
                ? 'Calls one tool on one of your connected apps. A read runs; a change waits for your approval card each time (a post always does), unless it provably publishes nothing.'
                : action.type === 'run_local_agent'
                  ? 'Starts a job on your Mac, in a folder you shared there, with nobody watching. It reports in your home thread, shows in the menu bar and the Agents panel, and stops from either. Anything risky it tries waits for your approval.'
                  : 'Sends an HTTP request to your endpoint. Wire it to Claude Code routines, Zapier, n8n, or your own webhook.'}
      </p>

      <Field label="Action type">
        <Select
          value={action.type}
          onValueChange={(v) => patch({ type: v as EditorAction['type'] })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="http_post">HTTP request</SelectItem>
            <SelectItem value="run_skill">Run skill</SelectItem>
            <SelectItem value="run_agent">Run agent</SelectItem>
            <SelectItem value="call_tool">Connected app</SelectItem>
            {/* archive_capture only does anything on a capture_processed fire
                (the only trigger that carries a capture). Offer it there, and
                keep it available when already selected so an existing action
                still shows its own type. */}
            {(trigger.kind === 'capture_processed' || action.type === 'archive_capture') && (
              <SelectItem value="archive_capture">Archive capture</SelectItem>
            )}
            {/* Set up in chat only (it needs a folder shared on the Mac): shown so an existing step keeps its own type. */}
            {action.type === 'run_local_agent' && <SelectItem value="run_local_agent">Job on your Mac</SelectItem>}
          </SelectContent>
        </Select>
      </Field>

      {/* Condition builder */}
      <ConditionBuilder
        condition={action.condition}
        onChange={(condition) => patch({ condition })}
        trigger={trigger}
        states={states}
        labels={labels}
        members={members}
        projects={projects}
      />

      <div className="h-px bg-border" />

      {action.type === 'run_skill' ? (
        <RunSkillFields action={action} patch={patch} skills={skills} />
      ) : action.type === 'run_agent' ? (
        <RunAgentFields action={action} patch={patch} agents={agents} trigger={trigger} />
      ) : action.type === 'archive_capture' ? (
        <ArchiveCaptureFields trigger={trigger} />
      ) : action.type === 'call_tool' ? (
        <CallToolFields action={action} patch={patch} ancestors={ancestorSteps(actions, action.id)} trigger={trigger} />
      ) : action.type === 'run_local_agent' ? (
        <LocalAgentFields action={action} />
      ) : (
        <HttpPostFields action={action} patch={patch} />
      )}
    </div>
  )
}

/** The template tokens a connected-app step can use: its ancestors' outputs, then the call's. */
function stepTokens(ancestors: EditorAction[], trigger: EditorTrigger): string[] {
  const steps = ancestors.map((a) => `{{steps.${a.id}.output}}`)
  const call = trigger.kind === 'capture_processed' ? ['{{trigger.capture.title}}', '{{capture.id}}'] : ['{{entity.name}}', '{{entity.url}}']
  return [...steps, ...call]
}

function CallToolFields({
  action,
  patch,
  ancestors,
  trigger,
}: {
  action: EditorAction
  patch: (p: Partial<EditorAction>) => void
  ancestors: EditorAction[]
  trigger: EditorTrigger
}) {
  const connections = useEditorConnections()
  const picked = connections?.find((c) => c.id === action.connection) ?? null
  const inputOk = parseToolInput(action.tool_input) !== null
  // Nothing connected: one line, no empty picker (hide empty widgets).
  if (connections && connections.length === 0 && !action.connection) {
    return (
      <p className="rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
        Connect an app first: ask the agent to connect it, or add it in Settings.
      </p>
    )
  }
  return (
    <>
      <Field label="App">
        <Select value={action.connection || undefined} onValueChange={(v) => patch({ connection: v, tool: '' })}>
          <SelectTrigger>
            <SelectValue placeholder={connections ? 'Pick a connected app' : 'Loading…'} />
          </SelectTrigger>
          <SelectContent>
            {(connections ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id} disabled={!c.is_enabled}>
                {c.display_name}
                {c.is_enabled ? '' : ' (off)'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {picked && (
        <Field label="Tool">
          <Select value={action.tool || undefined} onValueChange={(v) => patch({ tool: v })}>
            <SelectTrigger>
              <SelectValue placeholder="Pick a tool" />
            </SelectTrigger>
            <SelectContent>
              {picked.tools.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      <Field label="Input">
        <Textarea
          value={action.tool_input}
          onChange={(e) => patch({ tool_input: e.target.value })}
          rows={6}
          spellCheck={false}
          aria-invalid={!inputOk}
          className="font-mono text-xs"
        />
        {!inputOk ? (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">The input must be a JSON object.</p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            JSON, checked against the tool&rsquo;s own inputs when you save. Use an earlier step&rsquo;s output in any text:
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap gap-1">
          {stepTokens(ancestors, trigger).map((token) => (
            <code key={token} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {token}
            </code>
          ))}
        </div>
      </Field>
    </>
  )
}

/** A Mac job's step (L5), read only: it is set up and changed in chat, where its folder can be picked. */
function LocalAgentFields({ action }: { action: EditorAction }) {
  const step = action.stored_local_agent
  return (
    <div className="space-y-3">
      <Field label="Request">
        <p className="whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          {step?.request?.trim() || 'No request yet'}
        </p>
      </Field>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {step?.mode === 'edit' ? 'It may change files, always in a git worktree, so your checkout stays as it is.' : 'It only reads the folder.'}{' '}
        To change this step, ask the agent in chat.
      </p>
    </div>
  )
}

function ArchiveCaptureFields({ trigger }: { trigger: EditorTrigger }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
      {trigger.kind === 'capture_processed' ? (
        <>
          No configuration needed — this archives the capture that fired the flow. Pair it with a
          condition to archive only certain captures. Archiving is reversible (the capture and its
          audio are kept); demo captures are never archived.
        </>
      ) : (
        <>
          This action only does something on a{' '}
          <span className="font-medium text-foreground">capture processed</span> flow — other
          triggers carry no capture, so the flow can&rsquo;t be saved with it. Change the trigger to
          &ldquo;capture processed&rdquo;, or remove this action.
        </>
      )}
    </div>
  )
}

function HttpPostFields({
  action,
  patch,
}: {
  action: EditorAction
  patch: (p: Partial<EditorAction>) => void
}) {
  const addHeader = () => patch({ headers: [...action.headers, { key: '', value: '' }] })
  const removeHeader = (i: number) => patch({ headers: action.headers.filter((_, idx) => idx !== i) })
  const setHeader = (i: number, key: 'key' | 'value', val: string) =>
    patch({ headers: action.headers.map((h, idx) => (idx === i ? { ...h, [key]: val } : h)) })

  return (
    <>
      <div className="grid grid-cols-[96px_1fr] gap-3">
        <Field label="Method">
          <Select value={action.method} onValueChange={(v) => patch({ method: v as 'POST' })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="POST">POST</SelectItem>
              <SelectItem value="PUT">PUT</SelectItem>
              <SelectItem value="PATCH">PATCH</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="URL">
          <Input
            value={action.url}
            onChange={(e) => patch({ url: e.target.value })}
            placeholder="https://api.example.com/webhook"
          />
        </Field>
      </div>

      <Field label="Bearer token (optional)">
        <Input
          type="password"
          value={action.bearer_token}
          onChange={(e) => patch({ bearer_token: e.target.value })}
          placeholder={action.bearer_token_present ? '•••• stored — type to replace' : 'sk-ant-...'}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Sent as <code className="font-mono">Authorization: Bearer …</code>. Encrypted at rest.
        </p>
      </Field>

      <Field label="Headers">
        <div className="space-y-2">
          {action.headers.map((h, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                placeholder="Name"
                value={h.key}
                onChange={(e) => setHeader(i, 'key', e.target.value)}
                className="flex-1"
              />
              <Input
                placeholder="Value"
                value={h.value}
                onChange={(e) => setHeader(i, 'value', e.target.value)}
                className="flex-1"
              />
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => removeHeader(i)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={addHeader}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add header
          </Button>
        </div>
      </Field>

      <Field label="Body template">
        <Textarea
          value={action.body_template}
          onChange={(e) => patch({ body_template: e.target.value })}
          rows={6}
          className="font-mono text-xs"
        />
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="mt-1 h-7 text-xs">
              <ChevronDown className="mr-1 h-3 w-3" />
              Available tokens
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-1 rounded border border-border bg-muted/30 p-2">
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
                {TEMPLATE_TOKENS.map((tok) => (
                  <code key={tok}>{tok}</code>
                ))}
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Field>
    </>
  )
}

/**
 * The tool-scope facts a skill's agent_config carries. `/api/account/skills`
 * returns the full recipe row (LIBRARY_ITEM_FIELDS includes agent_config), so
 * the picker's SkillOption rows carry this at runtime even though the shared
 * SkillOption type (flow-types.ts) only declares the display subset. Read it
 * defensively — a legacy row may omit agent_config entirely.
 */
interface SkillToolConfig {
  enabled_tools?: string[]
  disabled_tools?: string[]
  /**
   * 'verdict' turns a skill into a triage-class skill: it runs on the
   * read-only ceiling and the server applies its structured verdict (the trust
   * gate, attention cards).
   */
  output_contract?: string
}

function readSkillToolConfig(skill: SkillOption | undefined): SkillToolConfig {
  const cfg = (skill as { agent_config?: unknown } | undefined)?.agent_config
  if (!cfg || typeof cfg !== 'object') return {}
  const { enabled_tools, disabled_tools, output_contract } = cfg as SkillToolConfig
  return {
    enabled_tools: Array.isArray(enabled_tools) ? enabled_tools : undefined,
    disabled_tools: Array.isArray(disabled_tools) ? disabled_tools : undefined,
    output_contract: typeof output_contract === 'string' ? output_contract : undefined,
  }
}

const CHIP_CLASS =
  'rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground'

/**
 * The skill's REAL tool boundary for the SELECTED mode, shown so a flow author
 * can see exactly what this run can touch before wiring it up. This mirrors the
 * enforced ceiling (computeSkillCeiling in src/lib/flows/run-skill.ts) branch by
 * branch — the display must never overstate what enforcement grants:
 *
 *   - Report: the ceiling is computeReportModeCeiling — read-only tools plus the
 *     two writes a report run is defined to produce (create_document /
 *     add_comment) — regardless of the skill's own scope. So we show "Read-only"
 *     + those two writes and ignore the category list entirely.
 *   - Act with a populated enabled_tools list: computeToolCeiling with those
 *     categories → show the category chips.
 *   - Act with an empty/absent enabled_tools list: computeSkillCeiling passes it
 *     through as `undefined`, which computeToolCeiling resolves to the CORE
 *     fall-through — NOT inherit-all. So we show "Core tools only", not "All
 *     tools" (the old label overstated an empty-scope skill's reach).
 *
 * enabled_tools holds TOOL_CATEGORY ids (captures, actions, …); disabled_tools
 * holds individual tool names carved out of those categories — the "Excluded"
 * row only applies in Act mode (Report ignores the category scope).
 */
function SkillToolScope({
  skill,
  mode,
}: {
  skill: SkillOption | undefined
  mode: EditorAction['mode']
}) {
  const { enabled_tools, disabled_tools } = readSkillToolConfig(skill)
  const categories = (enabled_tools ?? []).map((id) => ({
    id,
    label: TOOL_CATEGORIES.find((c) => c.id === id)?.label ?? id,
  }))
  const excluded = (disabled_tools ?? []).map((name) => ({
    name,
    label: getToolDefinition(name)?.label ?? name,
  }))

  // Report mode's surface is fixed by computeReportModeCeiling — read-only plus
  // the two allowed writes — independent of the skill's category scope.
  if (mode === 'report') {
    const writes = REPORT_MODE_WRITE_ALLOWLIST.map(
      (name) => getToolDefinition(name)?.label ?? name,
    )
    return (
      <Field label="Tool scope">
        <div className="flex flex-wrap gap-1">
          <span className={CHIP_CLASS}>Read-only</span>
          {writes.map((label) => (
            <span key={label} className={CHIP_CLASS}>
              {label}
            </span>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Report runs are read-only, plus writing their own output document and comments.
        </p>
      </Field>
    )
  }

  // Act mode: the ceiling is the skill's own category scope, with an empty scope
  // resolving to CORE tools only (never inherit-all).
  return (
    <Field label="Tool scope">
      {categories.length === 0 ? (
        <span className={`inline-flex ${CHIP_CLASS}`}>Core tools only</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {categories.map((c) => (
            <span key={c.id} className={CHIP_CLASS}>
              {c.label}
            </span>
          ))}
        </div>
      )}
      {excluded.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-muted-foreground">Excluded:</span>
          {excluded.map((t) => (
            <span
              key={t.name}
              className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground line-through"
            >
              {t.label}
            </span>
          ))}
        </div>
      )}
      <p className="mt-1.5 text-xs text-muted-foreground">
        The skill&apos;s own tool boundary. Act runs with exactly this scope.
      </p>
    </Field>
  )
}

function RunSkillFields({
  action,
  patch,
  skills,
}: {
  action: EditorAction
  patch: (p: Partial<EditorAction>) => void
  skills: SkillOption[]
}) {
  const selectedSkill = action.skill_id
    ? skills.find((s) => s.id === action.skill_id)
    : undefined

  return (
    <>
      <Field label="Skill">
        <Select value={action.skill_id || undefined} onValueChange={(v) => patch({ skill_id: v })}>
          <SelectTrigger>
            <SelectValue placeholder="Pick a skill" />
          </SelectTrigger>
          <SelectContent>
            {skills.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.icon ? `${s.icon} ` : ''}
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {skills.length === 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            No skills yet — create one under Personas.
          </p>
        )}
      </Field>

      {/* Show the picked skill's real tool boundary for the SELECTED mode — the
          enforced ceiling this run gets (computeSkillCeiling). */}
      {selectedSkill && <SkillToolScope skill={selectedSkill} mode={action.mode} />}

      <Field label="Mode">
        <Select
          value={action.mode}
          onValueChange={(v) => patch({ mode: v as EditorAction['mode'] })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="report">Report</SelectItem>
            <SelectItem value="act">Act</SelectItem>
          </SelectContent>
        </Select>
        <p className="mt-1 text-xs text-muted-foreground">
          Report: read-only, plus writing its output document and comments. Act: runs with the tool
          scope shown above.
        </p>
      </Field>

      <Field label="Instructions (optional)">
        <Textarea
          value={action.instructions}
          onChange={(e) => patch({ instructions: e.target.value })}
          rows={4}
          placeholder="Extra guidance appended to the skill each run…"
          className="text-xs"
        />
      </Field>

      <Field label="Delivery">
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={action.deliver_document}
              onCheckedChange={(v) => patch({ deliver_document: v === true })}
            />
            Write the output to a document
          </label>
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={action.deliver_notification}
              onCheckedChange={(v) => patch({ deliver_notification: v === true })}
            />
            Send an in-app notification
          </label>
        </div>
      </Field>
    </>
  )
}

function RunAgentFields({
  action,
  patch,
  agents,
  trigger,
}: {
  action: EditorAction
  patch: (p: Partial<EditorAction>) => void
  agents: AgentOption[]
  trigger: EditorTrigger
}) {
  // The "inherit from the triggering action" override only makes sense when the
  // trigger IS a status change on an action.
  const isActionTrigger =
    trigger.kind === 'entity_status_change' && trigger.entity_type === 'action'
  const inherits = action.use_triggering_action_context

  return (
    <>
      {/* This dispatches a REAL coding agent. */}
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5">
        <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
          This runs a coding agent in a sandbox and opens a pull request — it is not a report.
        </p>
      </div>

      {/* Inert state — dispatch is not yet enabled. */}
      <div className="rounded-md border border-border bg-muted/40 p-2.5">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Agent dispatch is not yet enabled. You can configure and save this action now; firing it
          records a run but does not launch an agent until dispatch is turned on.
        </p>
      </div>

      {isActionTrigger && (
        <Field label="Context">
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={inherits}
              onCheckedChange={(v) => patch({ use_triggering_action_context: v === true })}
            />
            Use the triggering action&apos;s repo, agent, and issue context
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            Inherits the action&apos;s project repo, its assigned agent, and its issue details. Fill
            the fields below to override.
          </p>
        </Field>
      )}

      <Field label="Agent">
        <Select value={action.agent_id || undefined} onValueChange={(v) => patch({ agent_id: v })}>
          <SelectTrigger>
            <SelectValue placeholder={inherits ? "Inherit the action's agent" : 'Pick an agent'} />
          </SelectTrigger>
          <SelectContent>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.icon ? `${a.icon} ` : ''}
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {agents.length === 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            No personas yet — create one under Personas.
          </p>
        )}
      </Field>

      <Field label="Repository">
        <Input
          value={action.repo}
          onChange={(e) => patch({ repo: e.target.value })}
          placeholder={inherits ? "Inherit the action's project repo" : 'owner/repo'}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          The GitHub repo to check out and open a PR against. Must be accessible to whoever last
          edited this flow.
        </p>
      </Field>

      <Field label="Instructions (optional)">
        <Textarea
          value={action.agent_instructions}
          onChange={(e) => patch({ agent_instructions: e.target.value })}
          rows={4}
          placeholder="What the agent should do… (template tokens like {{capture.title}} are rendered at fire time)"
          className="text-xs"
        />
      </Field>
    </>
  )
}

// ── Condition builder ─────────────────────────────────────────

/** Which ops are offered per field. Multi-valued fields use set ops. */
function opsForField(field: ConditionField): ConditionOp[] {
  switch (field) {
    case 'label':
    case 'assignee':
      return ['in', 'not_in', 'is_set', 'is_not_set']
    case 'priority':
    case 'project':
    case 'team':
    case 'from_status':
      return ['is', 'is_not', 'in', 'not_in', 'is_set', 'is_not_set']
    default:
      return ['is', 'is_not']
  }
}

const OP_LABELS: Record<ConditionOp, string> = {
  is: 'is',
  is_not: 'is not',
  in: 'is any of',
  not_in: 'is none of',
  is_set: 'is set',
  is_not_set: 'is not set',
}

function ConditionBuilder({
  condition,
  onChange,
  trigger,
  states,
  labels,
  members,
  projects,
}: {
  condition: EditorCondition
  onChange: (c: EditorCondition) => void
  trigger: EditorTrigger
  states: WorkflowState[]
  labels: LabelType[]
  members: Member[]
  projects: Project[]
}) {
  const setRule = (id: string, patch: Partial<EditorRule>) =>
    onChange({ ...condition, rules: condition.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) })
  const addRule = () => onChange({ ...condition, enabled: true, rules: [...condition.rules, newRule()] })
  const removeRule = (id: string) =>
    onChange({ ...condition, rules: condition.rules.filter((r) => r.id !== id) })

  const toggle = (enabled: boolean) => {
    if (enabled && condition.rules.length === 0) {
      onChange({ ...condition, enabled: true, rules: [newRule()] })
    } else {
      onChange({ ...condition, enabled })
    }
  }

  // Workspace-scoped triggers (schedule / capture_processed / calendar_event)
  // fire with NO triggering entity, so entity-field rules (label, priority,
  // assignee, project, team) evaluate against empty sets and silently never
  // match — the action would never run. Warn instead of letting the user set a
  // condition that can't fire. `from_status` is a property of a status-change
  // transition and is equally moot here.
  const isEntityless = trigger.kind !== 'entity_status_change'
  const hasEntityFieldRule =
    condition.enabled && condition.rules.some((r) => r.field !== 'from_status')

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <label className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <Filter className="h-3.5 w-3.5 text-amber-500" />
          Only run if…
        </span>
        <Switch checked={condition.enabled} onCheckedChange={toggle} />
      </label>

      {isEntityless && hasEntityFieldRule && (
        <p className="mt-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
          This trigger has no entity to test — rules on labels, priority, assignee, project, or
          team will never match, so the action won&rsquo;t run. Remove the condition to always run.
        </p>
      )}

      {condition.enabled && (
        <div className="mt-3 space-y-2">
          {condition.rules.length > 1 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Match</span>
              <Select
                value={condition.match}
                onValueChange={(v) => onChange({ ...condition, match: v as 'all' | 'any' })}
              >
                <SelectTrigger className="h-7 w-28 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">all (AND)</SelectItem>
                  <SelectItem value="any">any (OR)</SelectItem>
                </SelectContent>
              </Select>
              <span>of the rules</span>
            </div>
          )}

          {condition.rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              onChange={(p) => setRule(rule.id, p)}
              onRemove={() => removeRule(rule.id)}
              trigger={trigger}
              states={states}
              labels={labels}
              members={members}
              projects={projects}
            />
          ))}

          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={addRule}>
            <Plus className="mr-1 h-3 w-3" /> Add rule
          </Button>
        </div>
      )}
    </div>
  )
}

function RuleRow({
  rule,
  onChange,
  onRemove,
  trigger,
  states,
  labels,
  members,
  projects,
}: {
  rule: EditorRule
  onChange: (p: Partial<EditorRule>) => void
  onRemove: () => void
  trigger: EditorTrigger
  states: WorkflowState[]
  labels: LabelType[]
  members: Member[]
  projects: Project[]
}) {
  const ops = opsForField(rule.field)
  const needsValue = !NULLARY_OPS.includes(rule.op)
  const isScalar = SCALAR_OPS.includes(rule.op)

  // Options for the value control depend on the field.
  const options: Array<{ value: string; label: string }> = (() => {
    switch (rule.field) {
      case 'label':
        return labels.map((l) => ({ value: l.id, label: l.name }))
      case 'assignee':
        return members.map((m) => ({ value: m.id, label: m.display_name ?? 'Unknown' }))
      case 'project':
        return projects.map((p) => ({ value: p.id, label: p.name }))
      case 'from_status':
        return states.map((s) => ({ value: s.id, label: s.name }))
      case 'priority':
        return Object.entries(PRIORITY_LABELS).map(([value, label]) => ({ value, label }))
      case 'team':
        // Team options aren't loaded into this builder (the flow is single-team);
        // fall back to the trigger's team. Rarely used — present for completeness.
        return []
      default:
        return []
    }
  })()

  const onFieldChange = (field: ConditionField) => {
    // Reset op to a valid one for the new field, and clear the value.
    const validOps = opsForField(field)
    const op = validOps.includes(rule.op) ? rule.op : validOps[0]
    onChange({ field, op, value: [] })
  }

  const onOpChange = (op: ConditionOp) => {
    // Switching to/from scalar collapses the value appropriately.
    if (NULLARY_OPS.includes(op)) onChange({ op, value: [] })
    else if (SCALAR_OPS.includes(op)) onChange({ op, value: rule.value.slice(0, 1) })
    else onChange({ op })
  }

  const toggleValue = (val: string) => {
    if (isScalar) {
      onChange({ value: [val] })
    } else {
      onChange({
        value: rule.value.includes(val) ? rule.value.filter((v) => v !== val) : [...rule.value, val],
      })
    }
  }

  return (
    <div className="rounded-md border border-border bg-card p-2">
      <div className="flex items-center gap-1.5">
        <Select value={rule.field} onValueChange={(v) => onFieldChange(v as ConditionField)}>
          <SelectTrigger className="h-7 flex-1 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(CONDITION_FIELD_LABELS) as ConditionField[]).map((f) => (
              <SelectItem key={f} value={f}>
                {CONDITION_FIELD_LABELS[f]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={rule.op} onValueChange={(v) => onOpChange(v as ConditionOp)}>
          <SelectTrigger className="h-7 w-28 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ops.map((op) => (
              <SelectItem key={op} value={op}>
                {OP_LABELS[op]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          aria-label="Remove rule"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {needsValue && (
        <div className="mt-2">
          {options.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {rule.field === 'team'
                ? 'Team conditions aren’t configurable here yet.'
                : 'No options available.'}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {options.map((opt) => {
                const active = rule.value.includes(opt.value)
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => toggleValue(opt.value)}
                    className={
                      active
                        ? 'rounded-full border border-primary bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-foreground'
                        : 'rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground hover:border-muted-foreground/50'
                    }
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Shared field wrapper ──────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="mb-1.5 block text-xs">{label}</Label>
      {children}
    </div>
  )
}
