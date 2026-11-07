'use client'

/**
 * The one editor for every agent and the persona it's built on
 * (docs/plans/bots-v4.md, Phase B1). Two doors open it: a persona's row on
 * the Personas page (`agentId`), and an agent's Customize (`teammateId`: its
 * page's header). "New agent" opens it empty (`create`).
 *
 * Two parts:
 *   - THE PERSONA, shared by every agent on it (decision 11): its name in
 *     Personas, sharing, description, instructions, which tools and the skills
 *     it always checks (up to five). The other agents a save changes are named
 *     before you save, with "Make a copy for this agent" to split this one off.
 *   - THIS AGENT, its own: name, voice (Phase B2: one of the desktop's voices
 *     with a sample to hear, or Automatic; bot-voice-field.tsx, not shown in
 *     the browser), team, and what it may change on its own (decision 12:
 *     owners and admins, "Read only" or "Read, and change Dial8 records").
 *     From the Personas page it's the persona's first agent, with a switcher
 *     when there are several.
 * A field the agent's kind or the person can't change shows read-only with the
 * reason (editable-fields.ts, the same rules the routes check). A system
 * teammate and a loop's work agent have no persona of their own: the editor
 * says what they speak from, and offers their name and voice (and a system
 * teammate's skills).
 *
 * Saving goes persona first, then this agent, each through its own route
 * (editor-model.ts planEditorSave); a step that fails stops the rest and the
 * editor says what saved and what didn't.
 *
 * `workspaceId`: an agent in a workspace other than the active one; every
 * request carries it (x-workspace-id), so the routes judge it in its own
 * workspace.
 */
import { useEffect, useId, useState } from 'react'
import { Copy, Globe, Loader2, Settings2, User, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  ToolSelectionTree,
  buildSubmitBody,
  defaultForm,
  formFromRow,
  type EditorForm,
} from '@/app/account/(dashboard)/views/agents/item-dialogs'
import type { LibraryRow } from '@/app/account/(dashboard)/views/agents/library-types'
import { useOptionalSettingsOverlay } from '@/app/account/(dashboard)/settings-overlay'
import { ListenBrief } from '@/components/read-aloud/listen-brief'
import { plainLine } from '@/lib/read-aloud/listen-briefs'
import { announceTeammatesChanged } from '@/lib/bots/teammates-changed'
import { TOOL_CATEGORIES } from '@/lib/ai/tool-registry'
import { WORK_ROLE_LABELS, isWorkRole } from '@/lib/work/roles'
import {
  AGENT_FIELDS,
  BOT_FIELDS,
  BOUNDS_HINTS,
  BOUNDS_LABELS,
  FIELD_REASONS,
  copyNameFor,
  mayRepointToCopy,
  type BoundsChoice,
  type EditorField as EditorFieldName,
  type FieldRule,
} from '@/lib/agents/editable-fields'
import {
  botFieldsOf,
  editorRules,
  makeCopyForBot,
  otherBotsPhrase,
  planEditorSave,
  runEditorSave,
  saveFailureMessage,
  workspaceHeaders,
  type AgentEditorData,
  type AgentFields,
  type BotFields,
  type EditorBot,
} from '@/lib/agents/editor-model'
import { AgentIcon } from './agent-icon'
import { PinnedSkillsPicker, type SkillOption } from './pinned-skills-picker'
import { BotVoiceField } from './bot-voice-field'
import { EditorField } from './editor-field'

export interface AgentEditorDialogProps {
  open: boolean
  /** Open on this persona (the Personas page). */
  agentId?: string | null
  /** Open on this agent (its Customize). */
  teammateId?: string | null
  /** Make a new agent ("New agent"). */
  create?: boolean
  /** The agent's workspace, when it isn't the active one. */
  workspaceId?: string | null
  onClose: () => void
  /** After a save: the agent saved (a new one after a create or a copy). */
  onSaved?: (result: { agentId: string | null; created?: boolean }) => void
}

export function AgentEditorDialog(props: AgentEditorDialogProps) {
  const { open, onClose } = props
  // Opened on another persona or agent (a history step while open): start over on it.
  const opening = `${props.create ? 'new' : ''}:${props.agentId ?? ''}:${props.teammateId ?? ''}`
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {open && (
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-3xl" data-agent-editor="">
          <AgentEditorBody key={opening} {...props} />
        </DialogContent>
      )}
    </Dialog>
  )
}

/** What the editor is open on: after "Make a copy for this agent" it reopens on that agent. */
type EditorTarget = { agentId?: string | null; teammateId?: string | null }

/** The agent's fields as the PATCH takes them, from the form. */
function agentFieldsOf(form: EditorForm): AgentFields {
  const body = buildSubmitBody(form, true)
  return {
    name: body.name as string,
    visibility: body.visibility as AgentFields['visibility'],
    description: (body.description as string | undefined) ?? '',
    system_prompt: body.system_prompt as string,
    agent_config: body.agent_config as Record<string, unknown>,
  }
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** The rules for "New agent": its author sets everything on it, its voice included. */
const CREATE_RULES = Object.fromEntries([...AGENT_FIELDS, ...BOT_FIELDS].map((f) => [f, { editable: true }])) as Record<EditorFieldName, FieldRule>

function kindLine(bot: EditorBot, agentName: string | null): string {
  switch (bot.kind) {
    case 'system_teammate':
      return bot.about ? `A built-in agent. ${bot.about}.` : 'A built-in agent.'
    case 'loop_work_bot':
      return bot.about ? `A loop’s agent. ${bot.about}` : 'A loop’s agent.'
    case 'agent_work_bot':
      return `A work agent for ${agentName ?? 'its persona'}: it reads and proposes changes for you to approve.`
    case 'role_teammate':
      return `${isWorkRole(bot.role) ? WORK_ROLE_LABELS[bot.role] : 'A role'} agent${bot.team_name ? ` on ${bot.team_name}` : ''}.`
    default:
      return `${agentName ? `The agent for ${agentName}` : 'An agent'}${bot.team_name ? `, on ${bot.team_name}` : ''}.`
  }
}

function AgentEditorBody({ agentId, teammateId, create = false, workspaceId, onClose, onSaved }: AgentEditorDialogProps) {
  const settings = useOptionalSettingsOverlay()
  const ids = { agent: useId(), bot: useId(), skills: useId(), bounds: useId() }
  const [target, setTarget] = useState<EditorTarget>({ agentId, teammateId })
  const [reload, setReload] = useState(0)
  const [data, setData] = useState<AgentEditorData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [skillOptions, setSkillOptions] = useState<SkillOption[]>([])

  const [form, setForm] = useState<EditorForm>(() => defaultForm('agent'))
  const [formBefore, setFormBefore] = useState<EditorForm | null>(null)
  const [skills, setSkills] = useState<string[]>([])
  const [skillsBefore, setSkillsBefore] = useState<string[]>([])
  const [focusId, setFocusId] = useState<string | null>(null)
  const [bot, setBot] = useState<BotFields | null>(null)
  const [botBefore, setBotBefore] = useState<BotFields | null>(null)
  /** The voice an agent to be made starts with (a new one's, or "Give it an agent"; null: Automatic). */
  const [newBotVoice, setNewBotVoice] = useState<string | null>(null)
  const [givingBot, setGivingBot] = useState(create)
  const [showTools, setShowTools] = useState(create)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  // ── Load ──
  useEffect(() => {
    let live = true
    const headers = workspaceHeaders(workspaceId)
    fetch('/api/account/skills', { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { skills?: Array<{ id: string; name: string; description: string | null; color: string | null; visibility: string }> } | null) => {
        if (!live) return
        setSkillOptions(
          (body?.skills ?? [])
            .filter((s) => s.visibility !== 'personal')
            .map((s) => ({ id: s.id, name: s.name, description: s.description ?? null, color: s.color ?? null })),
        )
      })
      .catch(() => {})
    if (create) return () => void (live = false)
    const query = target.teammateId ? `teammate=${encodeURIComponent(target.teammateId)}` : `agent=${encodeURIComponent(target.agentId ?? '')}`
    setData(null)
    setLoadError(null)
    fetch(`/api/account/agent-editor?${query}`, { headers })
      .then(async (r) => {
        if (!live) return
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as { error?: string } | null
          setLoadError(body?.error || 'Couldn’t open this agent.')
          return
        }
        const next = (await r.json()) as AgentEditorData
        setData(next)
        const seeded = next.agent ? formFromRow({ ...(next.agent as unknown as LibraryRow), category: 'agent' }) : defaultForm('agent')
        setForm(seeded)
        setFormBefore(seeded)
        const focus = next.bots.find((b) => b.id === next.focus) ?? next.bots[0] ?? null
        setFocusId(focus?.id ?? null)
        setSkills(focus?.skill_ids ?? [])
        setSkillsBefore(focus?.skill_ids ?? [])
        const fields = focus ? botFieldsOf(focus) : null
        setBot(fields)
        setBotBefore(fields)
        setNewBotVoice(null)
        setGivingBot(false)
      })
      .catch(() => live && setLoadError('Couldn’t open this agent.'))
    return () => void (live = false)
  }, [create, target, workspaceId, reload])

  // ── What's on screen ──
  const agent = data?.agent ?? null
  const bots = data?.bots ?? []
  const focusBot = bots.find((b) => b.id === focusId) ?? null
  const rules = create ? CREATE_RULES : data ? editorRules(data, focusBot) : null
  const others = bots.filter((b) => b.id !== focusId)
  const hidden = data?.hidden_bots ?? 0
  const otherCount = others.length + hidden
  const hasBots = bots.length + hidden > 0
  const isPersonal = form.visibility === 'personal'
  const agentName = agent?.name ?? null
  // An agent to make on save: a new shared persona's, or "Give it an agent" for one with none.
  const makingBot = create ? !isPersonal : givingBot && !hasBots && !isPersonal
  const skillsHome = create ? !isPersonal : focusBot !== null || makingBot

  /** The save's requests, agent first, for the agent the edits go to (the copy, after "Make a copy"). */
  const planFor = (agentId: string | null) =>
    !data || !rules
      ? []
      : planEditorSave({
          agentId,
          bot: focusBot,
          rules,
          agentBefore: formBefore && agent ? agentFieldsOf(formBefore) : null,
          agentAfter: agent ? agentFieldsOf(form) : null,
          skillsBefore,
          skillsAfter: skills,
          botBefore,
          botAfter: bot,
          newBot: makingBot,
          newBotVoice: makingBot ? newBotVoice : null,
        })
  const steps = create ? [] : planFor(agent?.id ?? null)

  const touchesAgent = steps.some((s) => s.key === 'agent' || s.key === 'agent_skills')
  const botDirty =
    !!bot &&
    !!botBefore &&
    (bot.name !== botBefore.name ||
      (bot.voice ?? null) !== (botBefore.voice ?? null) ||
      bot.team_id !== botBefore.team_id ||
      bot.bounds !== botBefore.bounds)
  const dirty = steps.length > 0
  const publishing = form.visibility === 'public' && (formBefore?.visibility ?? 'workspace') !== 'public'
  // An agent with no persona of its own (a system teammate, a loop's agent) has only its own name to fill.
  const nameOk = (create || agent ? !!form.name.trim() : true) && (!bot || !!bot.name.trim())
  const canSave = !saving && nameOk && (create || dirty)
  const canCopy =
    !create &&
    !!agent &&
    !!focusBot &&
    mayRepointToCopy(focusBot.kind) &&
    !!rules?.name.editable &&
    (otherCount > 0 || agent.kind === 'builtin')
  const skillsDiffer = !!focusBot && bots.some((b) => !sameList(b.skill_ids, focusBot.skill_ids))

  function focus(next: EditorBot) {
    setFocusId(next.id)
    const fields = botFieldsOf(next)
    setBot(fields)
    setBotBefore(fields)
    // An unsaved skills edit stays; otherwise show what this agent checks now.
    if (sameList(skills, skillsBefore)) {
      setSkills(next.skill_ids)
      setSkillsBefore(next.skill_ids)
    }
  }

  // ── Save ──
  async function createAgent() {
    setConfirming(false)
    setSaving(true)
    setSaveError(null)
    const headers = { 'Content-Type': 'application/json', ...workspaceHeaders(workspaceId) }
    const body = buildSubmitBody({ ...form, bot_character: null }, false)
    // Its agent's voice (none: Automatic). Its own: never copied from another agent.
    if (makingBot && newBotVoice) body.voice = newBotVoice
    const res = await fetch('/api/account/agents', { method: 'POST', headers, body: JSON.stringify(body) }).catch(() => null)
    if (!res || !res.ok) {
      const err = res ? ((await res.json().catch(() => null)) as { error?: string } | null)?.error : null
      setSaveError(err || 'Couldn’t create the agent.')
      setSaving(false)
      return
    }
    const made = (await res.json().catch(() => ({}))) as {
      agent?: { id?: string; name?: string }
      ai_team_member?: { name?: string }
      bot_error?: string
      skills_error?: string
    }
    const id = made.agent?.id ?? null
    // Its skills live on its agent: with no agent made, the ones picked have nowhere to go.
    const skillsDropped = !!id && !made.ai_team_member && skills.length > 0
    let skillsSaved = true
    if (id && made.ai_team_member && skills.length > 0) {
      const put = await fetch(`/api/account/agents/${id}/skills`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ skill_recipe_ids: skills }),
      }).catch(() => null)
      skillsSaved = !!put?.ok
    }
    setSaving(false)
    const name = made.agent?.name || form.name.trim()
    toast.success(`Persona “${name}” created`)
    if (made.ai_team_member) {
      announceTeammatesChanged()
      toast.success(`${made.ai_team_member.name || name} is under Agents now`)
    }
    if (made.bot_error) toast.warning(`Its agent wasn’t made: ${made.bot_error}`)
    if (skillsDropped) {
      toast.warning(
        isPersonal
          ? 'The skills you picked weren’t kept: they live on an agent, and a personal persona has none. Share it with the workspace to give it one, then add them.'
          : 'The skills you picked weren’t kept: they live on its agent, which wasn’t made. Give it an agent from its editor, then add them.',
      )
    }
    if (!skillsSaved) toast.warning('Its skills weren’t saved. Add them in its editor.')
    else if (made.skills_error && skills.length === 0) toast.warning(made.skills_error)
    onSaved?.({ agentId: id, created: true })
    onClose()
  }

  async function commit(copyFirst: boolean) {
    if (!data || !rules) return
    setConfirming(false)
    setSaving(true)
    setSaveError(null)
    let savingAgentId = agent?.id ?? null
    if (copyFirst && focusBot && agent) {
      const copy = await makeCopyForBot({
        agentId: agent.id,
        bot: focusBot,
        name: copyNameFor(agent.name, focusBot.name),
        workspaceId,
      })
      if (!copy.ok) {
        setSaveError(`Couldn’t make a copy for ${focusBot.name}: ${copy.error}`)
        setSaving(false)
        return
      }
      savingAgentId = copy.agentId
    }
    const plan = planFor(savingAgentId)
    const outcome = await runEditorSave(plan, { workspaceId })
    setSaving(false)
    for (const warning of outcome.warnings) toast.warning(warning)
    // Whatever saved (this agent's name or voice, its limits, its persona)
    // is in the roster the agents are listed and voiced from: the shared source
    // reloads now, here and in the app's other windows, not on its next load.
    if (outcome.saved.length > 0 || copyFirst) announceTeammatesChanged()
    if (!outcome.ok) {
      setSaveError(saveFailureMessage(outcome))
      // After a copy the agent is on the copy now: reopen on it, so a retry never copies twice.
      if (copyFirst && focusBot) setTarget({ teammateId: focusBot.id })
      return
    }
    toast.success(copyFirst && focusBot ? `${focusBot.name} now has its own copy of the persona` : 'Saved')
    onSaved?.({ agentId: savingAgentId })
    onClose()
  }

  function onSave() {
    if (!canSave) return
    if (publishing || (touchesAgent && otherCount > 0)) {
      setConfirming(true)
      return
    }
    if (create) void createAgent()
    else void commit(false)
  }

  /** "Make a copy for this agent" on its own: copy, point this agent at it, and reopen the editor on the copy. */
  async function copyForThisBot() {
    if (!agent || !focusBot) return
    setSaving(true)
    setSaveError(null)
    const copy = await makeCopyForBot({ agentId: agent.id, bot: focusBot, name: copyNameFor(agent.name, focusBot.name), workspaceId })
    setSaving(false)
    if (!copy.ok) {
      setSaveError(`Couldn’t make a copy for ${focusBot.name}: ${copy.error}`)
      return
    }
    announceTeammatesChanged()
    toast.success(`${focusBot.name} now has its own copy: ${copyNameFor(agent.name, focusBot.name)}`)
    onSaved?.({ agentId: copy.agentId })
    setTarget({ teammateId: focusBot.id })
    setReload((n) => n + 1)
  }

  function openAutonomy() {
    onClose()
    settings?.openSettings('autonomy')
  }

  // ── Render ──
  const loading = !create && !data && !loadError
  // Opened on an agent, the agent's name; on a persona, the persona's.
  const title = create ? 'New agent' : target.teammateId && focusBot ? focusBot.name : (agentName ?? focusBot?.name ?? 'Agent')

  return (
    <>
      {/* Listen mode: what this agent is and how it works, spoken as it opens (as its detail did). */}
      {agent && <ListenBrief kind="agent" id={agent.id} fallback={() => plainLine(agent.name, agent.description)} />}
      <DialogHeader className="shrink-0">
        <DialogTitle className="flex items-center gap-2">
          {focusBot && <AgentIcon className="h-4 w-4" />}
          <span className="min-w-0 truncate">{title}</span>
          {agent?.kind === 'builtin' && (
            <Badge variant="secondary" className="text-[10px]">
              Built in
            </Badge>
          )}
        </DialogTitle>
        <DialogDescription>
          {create
            ? 'A persona is how an agent works: its instructions, tools and skills. Shared with the workspace, it gets an agent of its own.'
            : 'The persona is shared by every agent on it. Each agent keeps its own name, voice, team and limits.'}
        </DialogDescription>
      </DialogHeader>

      <div className="-mx-6 min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-1">
        {loading ? (
          <div className="space-y-3 py-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : loadError ? (
          <p role="alert" className="py-6 text-center text-sm text-muted-foreground">
            {loadError}
          </p>
        ) : rules ? (
          <>
            {/* ── The persona ── */}
            <section aria-labelledby={ids.agent} data-editor-agent="" className="space-y-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 id={ids.agent} className="text-sm font-semibold">
                  The persona
                </h3>
                {canCopy && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    data-make-copy=""
                    disabled={saving || dirty}
                    title={dirty ? 'Save or undo your changes first' : undefined}
                    onClick={() => void copyForThisBot()}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Make a copy for this agent
                  </Button>
                )}
              </div>

              {!create && !agent ? (
                <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground" data-no-agent="">
                  {focusBot?.kind === 'loop_work_bot'
                    ? FIELD_REASONS.loopSpeaks
                    : focusBot?.kind === 'system_teammate'
                      ? FIELD_REASONS.systemSpeaks
                      : FIELD_REASONS.hiddenAgent}
                  {focusBot?.about ? ` ${focusBot.kind === 'system_teammate' ? `What it does: ${focusBot.about}.` : focusBot.about}` : ''}
                </p>
              ) : (
                <>
                  {!create && (
                    <p className="text-xs text-muted-foreground" data-agent-shared-by="">
                      {otherCount > 0
                        ? `Also used by ${otherBotsPhrase(others, hidden)}. A change to the persona changes them too.`
                        : hasBots
                          ? 'Only this agent uses it.'
                          : 'No agent uses it yet.'}
                    </p>
                  )}

                  <EditorField label="Name in Personas" rule={rules.agent_name}>
                    <Input
                      value={form.name}
                      onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                      placeholder="e.g. Sales Coach"
                      disabled={!rules.agent_name.editable}
                      autoFocus={create}
                    />
                  </EditorField>

                  <EditorField label="Sharing" rule={rules.sharing}>
                    <Select
                      value={form.visibility}
                      onValueChange={(v) => setForm((f) => ({ ...f, visibility: v as EditorForm['visibility'] }))}
                      disabled={!rules.sharing.editable}
                    >
                      <SelectTrigger data-agent-sharing="">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="personal" disabled={hasBots}>
                          <span className="flex items-center gap-2">
                            <User className="h-3.5 w-3.5" /> Personal{hasBots ? ' (it has agents)' : ''}
                          </span>
                        </SelectItem>
                        <SelectItem value="workspace">
                          <span className="flex items-center gap-2">
                            <Users className="h-3.5 w-3.5" /> Workspace
                          </span>
                        </SelectItem>
                        <SelectItem value="public">
                          <span className="flex items-center gap-2">
                            <Globe className="h-3.5 w-3.5" /> Public
                          </span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </EditorField>

                  <EditorField label="Description" rule={rules.description}>
                    <Input
                      value={form.description}
                      onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                      placeholder="What does this agent do?"
                      disabled={!rules.description.editable}
                    />
                  </EditorField>

                  <EditorField label="Instructions" hint="Its system prompt: how it works and what it cares about." rule={rules.instructions}>
                    <Textarea
                      value={form.system_prompt}
                      onChange={(e) => setForm((f) => ({ ...f, system_prompt: e.target.value }))}
                      placeholder="Describe the agent’s behavior…"
                      rows={6}
                      disabled={!rules.instructions.editable}
                      data-agent-instructions=""
                    />
                  </EditorField>

                  <EditorField label="Which tools" rule={rules.tools}>
                    {rules.tools.editable ? (
                      <Collapsible open={showTools} onOpenChange={setShowTools}>
                        <CollapsibleTrigger asChild>
                          <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                            {showTools ? 'Hide the tools' : `Show the tools (${toolSummary(form)})`}
                          </button>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <ToolSelectionTree
                            form={form}
                            setForm={setForm}
                            helperText="It can use only the selected tools, within what each agent may change on its own. Core tools are always available."
                          />
                        </CollapsibleContent>
                      </Collapsible>
                    ) : (
                      <p className="text-xs text-muted-foreground" data-tools-summary="">
                        {toolSummary(form)}
                      </p>
                    )}
                  </EditorField>
                </>
              )}

              {(agent || create || focusBot?.kind === 'system_teammate') && (
                <EditorField
                  label="Skills it always checks"
                  labelId={ids.skills}
                  hint="Each loads in full whenever it chats or works, so pick the few that matter. In a chat it can still load any other skill it needs."
                  rule={skillsHome ? rules.skills : { editable: false, reason: create ? 'A personal persona has no agent, and its skills live on its agent.' : 'Its skills live on its agent: give it an agent first.' }}
                >
                  {skillsHome && (
                    <>
                      {skillsDiffer && rules.skills.editable && focusBot?.kind !== 'system_teammate' && (
                        <p className="mb-1.5 text-[11px] text-amber-700 dark:text-amber-400" data-skills-differ="">
                          Its agents check different skills today. Saving a change gives them all this list.
                        </p>
                      )}
                      <PinnedSkillsPicker
                        value={skills}
                        onChange={setSkills}
                        options={skillOptions}
                        disabled={!rules.skills.editable}
                        labelledBy={ids.skills}
                      />
                    </>
                  )}
                </EditorField>
              )}
            </section>

            {/* ── This agent ── */}
            <section aria-labelledby={ids.bot} data-editor-bot="" className="space-y-4 border-t pt-5">
              <h3 id={ids.bot} className="text-sm font-semibold">
                {create ? 'Its agent' : 'This agent'}
              </h3>

              {bots.length > 1 && (
                <div role="group" aria-label="Agents on this persona" className="flex flex-wrap gap-1.5" data-bot-switcher="">
                  {bots.map((b) => {
                    const on = b.id === focusId
                    return (
                      <button
                        key={b.id}
                        type="button"
                        aria-pressed={on}
                        disabled={!on && botDirty}
                        title={!on && botDirty ? 'Save or undo this agent’s changes first' : undefined}
                        data-bot-chip={b.id}
                        onClick={() => focus(b)}
                        className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors disabled:opacity-50 ${
                          on ? 'border-primary bg-primary/10 font-medium' : 'hover:bg-muted'
                        }`}
                      >
                        <AgentIcon className="h-3 w-3" />
                        {b.name}
                        {b.team_name && <span className="text-muted-foreground">· {b.team_name}</span>}
                      </button>
                    )
                  })}
                </div>
              )}

              {create ? (
                isPersonal ? (
                  <p className="text-xs text-muted-foreground" data-agent-bot-personal="">
                    A personal persona has no agent. Share it with the workspace to give it one.
                  </p>
                ) : (
                  <BotVoiceField
                    botId={null}
                    name={form.name}
                    face={null}
                    value={newBotVoice}
                    saved={null}
                    onChange={setNewBotVoice}
                    rule={CREATE_RULES.voice}
                  />
                )
              ) : focusBot && bot ? (
                <BotFieldsPart
                  key={focusBot.id}
                  bot={focusBot}
                  fields={bot}
                  setFields={setBot}
                  rules={rules}
                  agentName={agentName}
                  teams={data?.teams ?? []}
                  faces={(data?.workspace_faces ?? []).filter((f) => f.id !== focusBot.id)}
                  boundsLabelId={ids.bounds}
                  onOpenAutonomy={settings ? openAutonomy : undefined}
                />
              ) : hidden > 0 ? (
                <p className="text-xs text-muted-foreground">Its agents are on private teams you’re not on.</p>
              ) : isPersonal ? (
                <div className="space-y-2" data-agent-bot-personal="">
                  <p className="text-xs text-muted-foreground">A personal persona has no agent. Share it with the workspace to give it one.</p>
                  {rules.sharing.editable && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setForm((f) => ({ ...f, visibility: 'workspace' }))
                        setGivingBot(true)
                      }}
                    >
                      Share it and give it an agent
                    </Button>
                  )}
                </div>
              ) : rules.agent_name.editable ? (
                givingBot ? (
                  <BotVoiceField
                    botId={null}
                    name={form.name}
                    face={null}
                    value={newBotVoice}
                    saved={null}
                    onChange={setNewBotVoice}
                    rule={rules.agent_name}
                    faces={data?.workspace_faces ?? []}
                  />
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">No agent runs on it yet. An agent does the work, tells you what it did, and you talk it through with it.</p>
                    <Button type="button" variant="outline" size="sm" data-give-bot="" onClick={() => setGivingBot(true)}>
                      Give it an agent
                    </Button>
                  </div>
                )
              ) : (
                <p className="text-xs text-muted-foreground">No agent runs on it yet. Its author, or an owner or admin, can give it one.</p>
              )}
            </section>
          </>
        ) : null}

        {saveError && (
          <p role="alert" className="text-xs text-destructive" data-editor-error="">
            {saveError}
          </p>
        )}
      </div>

      <DialogFooter className="shrink-0">
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={onSave} disabled={!canSave} data-editor-save="">
          {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
          {create ? 'Create' : 'Save'}
        </Button>
      </DialogFooter>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-editor-confirm="">
          <AlertDialogHeader>
            <AlertDialogTitle>{touchesAgent && otherCount > 0 ? `Change ${agentName ?? 'the persona'} for every agent on it?` : 'Publish to all Dial8 users?'}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {touchesAgent && otherCount > 0 && (
                  <p data-editor-confirm-others="">
                    This also changes {otherBotsPhrase(others, hidden)}. Their names, voices and limits stay their own.
                    {canCopy ? ' To change only this agent, make it a copy of the persona first.' : ''}
                  </p>
                )}
                {publishing && (
                  <p>
                    This persona will appear in Discover for every Dial8 user, across all workspaces, with your name as its author. Its
                    instructions stay hidden until someone adds it to their workspace.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {touchesAgent && otherCount > 0 && canCopy && (
              <Button variant="outline" data-confirm-copy="" onClick={() => void commit(true)}>
                Make a copy for this agent
              </Button>
            )}
            <AlertDialogAction data-confirm-save="" onClick={() => (create ? void createAgent() : void commit(false))}>
              {touchesAgent && otherCount > 0 ? 'Change it for all' : 'Publish'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** "Captures, Actions and 5 more" — the persona's tool categories, for a read-only summary. */
function toolSummary(form: EditorForm): string {
  const on = TOOL_CATEGORIES.filter((c) => form.enabled_tools.includes(c.id)).map((c) => c.label)
  if (on.length === TOOL_CATEGORIES.length && form.disabled_tools.length === 0) return 'Every tool'
  if (on.length === 0) return 'Core tools only'
  return on.length <= 3 ? on.join(', ') : `${on.slice(0, 2).join(', ')} and ${on.length - 2} more`
}

/** "This agent": its own name, voice, team and what it may change on its own. */
function BotFieldsPart({
  bot,
  fields,
  setFields,
  rules,
  agentName,
  teams,
  faces,
  boundsLabelId,
  onOpenAutonomy,
}: {
  bot: EditorBot
  fields: BotFields
  setFields: React.Dispatch<React.SetStateAction<BotFields | null>>
  rules: Record<EditorFieldName, FieldRule>
  agentName: string | null
  teams: AgentEditorData['teams']
  /** The other agents' voices and faces, for the voice field's Automatic. */
  faces: AgentEditorData['workspace_faces']
  boundsLabelId: string
  onOpenAutonomy?: () => void
}) {
  const teamOptions = teams.some((t) => t.id === bot.team_id) || !bot.team_id ? teams : [{ id: bot.team_id, name: bot.team_name ?? 'Its team', is_private: false }, ...teams]
  const attemptsStop = bot.autonomy === 'attempt' && fields.bounds === 'read'
  const fullTeammate = bot.kind === 'agent_teammate' || bot.kind === 'role_teammate'

  return (
    <div className="space-y-4" data-editor-bot-fields={bot.kind}>
      <p className="text-xs text-muted-foreground" data-bot-kind={bot.kind}>
        {kindLine(bot, agentName)}
      </p>

      <EditorField label="Name" rule={rules.name}>
        <Input
          value={fields.name}
          onChange={(e) => setFields((f) => (f ? { ...f, name: e.target.value } : f))}
          disabled={!rules.name.editable}
          data-bot-name=""
        />
      </EditorField>

      <BotVoiceField
        botId={bot.id}
        name={fields.name}
        face={fields.bot_character}
        value={fields.voice ?? null}
        saved={bot.voice ?? null}
        onChange={(voice) => setFields((f) => (f ? { ...f, voice } : f))}
        rule={rules.voice}
        faces={faces}
      />

      <EditorField label="Team" rule={rules.team}>
        <Select
          value={fields.team_id ?? ''}
          onValueChange={(v) => setFields((f) => (f ? { ...f, team_id: v } : f))}
          disabled={!rules.team.editable}
        >
          <SelectTrigger data-bot-team="">
            <SelectValue placeholder="No team" />
          </SelectTrigger>
          <SelectContent>
            {teamOptions.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
                {t.is_private ? ' (private)' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </EditorField>

      <EditorField label="What it may change on its own" labelId={boundsLabelId} rule={rules.bounds}>
        <div role="radiogroup" aria-labelledby={boundsLabelId} className="grid gap-1.5 sm:grid-cols-2" data-bot-bounds={fields.bounds}>
          {(['read', 'internal'] as BoundsChoice[]).map((choice) => {
            const on = fields.bounds === choice
            return (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!rules.bounds.editable}
                data-bounds-choice={choice}
                onClick={() => setFields((f) => (f ? { ...f, bounds: choice } : f))}
                className={`rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-default ${
                  on ? 'border-primary bg-primary/10' : 'hover:bg-muted disabled:hover:bg-transparent'
                } ${!rules.bounds.editable && !on ? 'opacity-50' : ''}`}
              >
                <span className="block text-sm font-medium">{BOUNDS_LABELS[choice]}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{BOUNDS_HINTS[choice]}</span>
              </button>
            )
          })}
        </div>
        {attemptsStop && (
          <p className="text-[11px] text-amber-700 dark:text-amber-400" data-attempts-stop="">
            It’s set to make first passes on its own. With Read only it stops: a first pass needs it to change Dial8 records.
          </p>
        )}
      </EditorField>

      {fullTeammate && onOpenAutonomy && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Settings2 className="h-3.5 w-3.5" />
          Its role and whether it makes first passes are in
          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={onOpenAutonomy}>
            Settings → Autonomy
          </button>
        </p>
      )}
    </div>
  )
}
