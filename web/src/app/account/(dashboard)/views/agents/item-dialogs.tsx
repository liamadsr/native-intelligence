'use client'

/**
 * The two dialogs behind the Agents & Skills page, and the form model the one
 * agent editor shares (components/agents/agent-editor.tsx, bots-v4 B1):
 *
 *   - DetailDialog  — read-only view of an item (system prompt, provenance):
 *                     a skill, a built-in agent, or a Discover listing. An agent
 *                     of the workspace opens in the agent editor instead.
 *   - EditorDialog  — the create/edit form, which the page opens for skills
 *                     (agents open in the agent editor). Guards a publish
 *                     (visibility→public) behind an AlertDialog.
 *   - EditorForm, formFromRow, buildSubmitBody, ToolSelectionTree — the form
 *     model and the tool tree, for skills here and agents in the editor.
 *
 * The dialog opens pre-set to the active tab's category, and the category is
 * locked on edit (body shape differs per type).
 */

import { useCallback, useState } from 'react'
import {
  ChevronRight,
  Download,
  GitFork,
  Globe,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  User,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TOOL_CATEGORIES, ALL_CATEGORY_IDS, isAttendedOnlyTool, isChatNativeTool } from '@/lib/ai/tool-registry'
import { AREA_OPTIONS, isAreaKey } from '@/lib/packs/registry'
import { LibraryItemIcon } from '@/components/library-item-icon'
import { LIBRARY_CATEGORY_LABELS as CATEGORY_LABELS } from '@/lib/types/library'
import { VisibilityBadge, BuiltInBadge } from './library-badges'
import { ListenBrief } from '@/components/read-aloud/listen-brief'
import { plainLine } from '@/lib/read-aloud/listen-briefs'
import { NAME_PLACEHOLDER, lineageChip } from './library-types'
import type { LibraryRow, LibraryCategory, LibraryVisibility, LibraryScope } from './library-types'

// ─── Form model ──────────────────────────────────────────────────────

export interface EditorForm {
  name: string
  description: string
  system_prompt: string
  category: LibraryCategory
  visibility: LibraryVisibility
  icon: string
  color: string
  enabled_tools: string[]
  disabled_tools: string[]
  response_format: string
  response_tone: string
  always_cite_sources: boolean
  context_rules: string[]
  /**
   * The row's original agent_config, verbatim. The form only surfaces a subset
   * of the keys it can carry (a forked system skill also holds preconditions /
   * output_contract, which no field here knows about). buildSubmitBody spreads
   * this UNDER the form-managed keys so an edit preserves those unknown keys
   * instead of clobbering them. Empty on create.
   */
  base_agent_config: Record<string, unknown>
  /**
   * A NEW agent's bot ("Give it a bot", bots-v3 Phase 6): a character's id or a
   * built bot's. Sent on create only; saving makes the agent's teammate.
   */
  bot_character: string | null
  /**
   * Skills only: the area whose pack loads this skill ("Use it whenever I work
   * on …", src/lib/packs/registry.ts). '' for none.
   */
  area: string
}

/** The area picker's "none" value: a Radix Select item can't hold ''. */
const NO_AREA = 'none'

export function defaultForm(category: LibraryCategory): EditorForm {
  return {
    name: '',
    description: '',
    system_prompt: '',
    category,
    visibility: 'workspace',
    icon: '',
    color: '#3b82f6',
    enabled_tools: [...ALL_CATEGORY_IDS],
    disabled_tools: [],
    response_format: 'detailed',
    response_tone: 'professional',
    always_cite_sources: true,
    context_rules: [''],
    base_agent_config: {},
    bot_character: null,
    area: '',
  }
}

/** Build an edit-mode form from an existing row. */
export function formFromRow(item: LibraryRow): EditorForm {
  const cfg = (item.agent_config || {}) as Record<string, unknown>
  const responseStyle = (cfg.response_style || {}) as Record<string, unknown>
  // Skills carry a tool scope too now (enforced when they run unattended in
  // Flows), so the tree is populated for both categories. An absent list means
  // "all tools" for an agent, but for a skill it means the narrow default (core
  // tools, or reads-and-drafts for one the agent wrote — skillActCeiling), so a
  // skill keeps it as [] and a prompt-only edit does not widen its scope.
  const enabledTools = Array.isArray(cfg.enabled_tools)
    ? (cfg.enabled_tools as string[])
    : item.category === 'skill'
      ? []
      : [...ALL_CATEGORY_IDS]
  const disabledTools = Array.isArray(cfg.disabled_tools) ? (cfg.disabled_tools as string[]) : []
  const contextRules =
    Array.isArray(cfg.context_rules) && cfg.context_rules.length > 0
      ? (cfg.context_rules as string[])
      : ['']
  return {
    name: item.name,
    description: item.description || '',
    system_prompt: item.system_prompt || '',
    category: item.category,
    visibility: item.visibility,
    icon: item.icon || '',
    color: item.color || '#3b82f6',
    enabled_tools: enabledTools,
    disabled_tools: disabledTools,
    response_format: (responseStyle.format as string) || 'detailed',
    response_tone: (responseStyle.tone as string) || 'professional',
    always_cite_sources: responseStyle.always_cite_sources !== false,
    context_rules: contextRules,
    // Preserve the full config so buildSubmitBody can re-emit keys the form
    // doesn't manage (preconditions, output_contract on forked system skills).
    base_agent_config: cfg,
    bot_character: null,
    area: isAreaKey(item.area) ? item.area : '',
  }
}

/**
 * Build a create-mode skill form from a parsed SKILL.md. Maps the standard
 * frontmatter + body onto the three form fields the import path fills (name,
 * description, prompt) and leaves everything else at its skill default. An empty
 * parsed name is passed through blank — the editor's required-name validation
 * handles it rather than inventing a name. Warnings are the caller's concern.
 */
export function formFromParsedSkill(parsed: {
  name: string
  description: string
  body: string
}): EditorForm {
  return {
    ...defaultForm('skill'),
    name: parsed.name,
    description: parsed.description,
    system_prompt: parsed.body,
  }
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Shape the POST/PATCH body from the form. Both categories carry the tool scope
 * (agents: the enforced chat boundary; skills: enforced when run unattended in
 * Flows) plus their type-specific config — skills also carry persona styling +
 * standing instructions. Slug is generated only on create so edits don't break
 * memorized slash-commands.
 *
 * The whole agent_config is rebuilt here and stored verbatim by the routes, so
 * the ORIGINAL config is spread in first and the form-managed keys layered on
 * top: keys the form owns win, and keys it doesn't know about (preconditions,
 * output_contract on forked system skills) survive the round-trip instead of
 * being dropped.
 */
export function buildSubmitBody(form: EditorForm, isEditMode: boolean): Record<string, unknown> {
  const name = form.name.trim()
  const body: Record<string, unknown> = {
    name,
    system_prompt: form.system_prompt,
    description: form.description || undefined,
    visibility: form.visibility,
  }
  const agentConfig: Record<string, unknown> = { ...form.base_agent_config }
  agentConfig.enabled_tools = form.enabled_tools
  agentConfig.disabled_tools = form.disabled_tools.filter(Boolean)
  if (form.category === 'skill') {
    if (!isEditMode) body.slug = generateSlug(name) || undefined
    body.area = form.area || null
    if (form.icon) body.icon = form.icon
    if (form.color) body.color = form.color
    agentConfig.response_style = {
      format: form.response_format,
      tone: form.response_tone,
      always_cite_sources: form.always_cite_sources,
    }
    agentConfig.context_rules = form.context_rules.filter((r) => r.trim())
  }
  body.agent_config = agentConfig
  // "Give it a bot": a new agent's teammate wears this face (the route makes it).
  // A personal agent has none: its bot would be on a team everyone sees.
  if (!isEditMode && form.category === 'agent' && form.visibility !== 'personal' && form.bot_character) {
    body.bot_character = form.bot_character
  }
  return body
}

// ─── Tool selection tree (shared: agents + skills) ───────────────────

/**
 * The TOOL_CATEGORIES allowlist tree. Shared by both editor branches: for agents
 * this is the enforced chat boundary; for skills it's the scope enforced when the
 * skill runs unattended in Flows. Same interaction either way (category toggle +
 * per-tool checkboxes writing enabled_tools/disabled_tools), so the tree is one
 * component and only the surrounding helper text differs.
 *
 * Chat-native tools (start_helper, the relay to the bots) are not listed,
 * like ask_user: no skill run can call one, and whether chat may start
 * helpers is the workspace's Settings → Autonomy choice. They still follow their category's
 * switch; picking single tools in an off category leaves them disabled.
 * Nor are a bot's attended-only tools (settle_card, revise_email_draft,
 * undo_extraction_pass): no skill run holds one, and a bot's chat gets one by
 * what it fronts, not by a pick.
 */
export function pickerTools(category: (typeof TOOL_CATEGORIES)[number]) {
  return category.tools.filter((t) => !isChatNativeTool(t.name) && !isAttendedOnlyTool(t.name))
}

export function ToolSelectionTree({
  form,
  setForm,
  helperText,
}: {
  form: EditorForm
  setForm: React.Dispatch<React.SetStateAction<EditorForm>>
  helperText: string
}) {
  return (
    <div>
      {/* No "Tools" sub-label — the section header already names the section;
          a second label just repeats it. */}
      <p className="text-muted-foreground mt-0.5 text-xs">{helperText}</p>
      <div className="mt-2 space-y-1.5">
        {TOOL_CATEGORIES.map((cat) => {
          const catEnabled = form.enabled_tools.includes(cat.id)
          const disabledTools = form.disabled_tools
          const shown = pickerTools(cat)
          const enabledCount = catEnabled
            ? shown.filter((t) => !disabledTools.includes(t.name)).length
            : 0
          const isPartial = catEnabled && enabledCount < shown.length
          return (
            <Collapsible key={cat.id}>
              <div
                className={`rounded-lg border transition-colors ${
                  catEnabled ? 'border-border bg-background' : 'bg-muted/40 border-transparent'
                }`}
              >
                <div className="flex items-center gap-3 px-3 py-2">
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground flex shrink-0 items-center justify-center rounded-md p-0.5"
                    >
                      <ChevronRight className="h-4 w-4 transition-transform [[data-state=open]>&]:rotate-90" />
                    </button>
                  </CollapsibleTrigger>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{cat.label}</span>
                      {isPartial && (
                        <span className="bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 text-[10px] font-medium">
                          {enabledCount}/{shown.length}
                        </span>
                      )}
                    </div>
                  </div>
                  <Switch
                    checked={catEnabled}
                    onCheckedChange={(checked) => {
                      setForm((f) => ({
                        ...f,
                        enabled_tools: checked
                          ? [...f.enabled_tools, cat.id]
                          : f.enabled_tools.filter((t) => t !== cat.id),
                        disabled_tools: checked
                          ? f.disabled_tools.filter((t) => !cat.tools.some((ct) => ct.name === t))
                          : f.disabled_tools,
                      }))
                    }}
                  />
                </div>
                <CollapsibleContent>
                  <div className="border-t px-3 pt-2 pb-2.5">
                    <div className="space-y-0.5">
                      {shown.map((t) => {
                        const toolDisabled = disabledTools.includes(t.name)
                        const toolActive = catEnabled && !toolDisabled
                        return (
                          <label
                            key={t.name}
                            className="hover:bg-muted/50 flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5"
                          >
                            <Checkbox
                              checked={toolActive}
                              className="mt-0.5"
                              onCheckedChange={(checked) => {
                                if (!catEnabled && checked) {
                                  setForm((f) => ({
                                    ...f,
                                    enabled_tools: [...f.enabled_tools, cat.id],
                                    disabled_tools: [
                                      ...f.disabled_tools.filter(
                                        (d) => !cat.tools.some((ct) => ct.name === d),
                                      ),
                                      ...cat.tools
                                        .filter((ct) => ct.name !== t.name)
                                        .map((ct) => ct.name),
                                    ],
                                  }))
                                  return
                                }
                                setForm((f) => ({
                                  ...f,
                                  disabled_tools: checked
                                    ? f.disabled_tools.filter((n) => n !== t.name)
                                    : [...f.disabled_tools, t.name],
                                }))
                              }}
                            />
                            <div className="min-w-0 select-none">
                              {/* Name first (the tool's identity), description under it. */}
                              <p
                                className={`font-mono text-[13px] leading-tight ${
                                  toolActive ? 'font-medium' : 'text-muted-foreground'
                                }`}
                              >
                                {t.name}
                              </p>
                              <p className="text-muted-foreground mt-0.5 text-xs leading-snug">
                                {t.description}
                              </p>
                            </div>
                          </label>
                        )
                      })}
                    </div>
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>
          )
        })}
      </div>
    </div>
  )
}

// ─── Skill tool-scope display (read-only) ────────────────────────────

/**
 * The category labels a skill's stored scope resolves to, for the read-only
 * chips in the detail dialog. An absent (or empty) enabled_tools list means
 * the skill runs with CORE tools only when it fires unattended in an Act flow —
 * NOT "all tools" (computeSkillCeiling in src/lib/flows/run-skill.ts passes an
 * empty scope through as `undefined`, which computeToolCeiling resolves to the
 * CORE_TOOL_NAMES fall-through, not inherit-all). So the caller shows a "Core
 * tools" placeholder instead of an empty row. Unknown ids (e.g. a raw tool name
 * from an older config) fall through to their own id as the label so the chip
 * is never blank.
 */
export function skillScopeLabels(config: Record<string, unknown> | null | undefined): string[] {
  const enabled = config && Array.isArray(config.enabled_tools) ? (config.enabled_tools as string[]) : null
  if (!enabled || enabled.length === 0) return []
  return enabled.map((id) => {
    const cat = TOOL_CATEGORIES.find((c) => c.id === id)
    return cat ? cat.label : id
  })
}

// ─── Detail dialog ───────────────────────────────────────────────────

export function DetailDialog({
  item,
  scope,
  isMine,
  forking,
  onClose,
  onEdit,
  onFork,
}: {
  item: LibraryRow | null
  scope: LibraryScope
  isMine: boolean
  forking: boolean
  onClose: () => void
  onEdit: (item: LibraryRow) => void
  onFork: (id: string) => void
}) {
  return (
    <Dialog open={!!item} onOpenChange={(open) => !open && onClose()}>
      {item && (
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          {/* Listen mode: what this agent or skill is and how it works, spoken
              as it opens. */}
          <ListenBrief
            kind={item.category === 'agent' ? 'agent' : 'skill'}
            id={item.id}
            fallback={() => plainLine(item.name, item.description)}
          />
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3">
              <LibraryItemIcon color={item.color} size="lg" seed={item.id || item.name} />
              <div>
                <div className="flex items-center gap-2">
                  {item.name}
                  <Badge variant="secondary" className="text-xs">
                    {CATEGORY_LABELS[item.category]}
                  </Badge>
                  {item.is_system && <BuiltInBadge />}
                </div>
                {item.description && (
                  <p className="text-muted-foreground mt-0.5 text-sm font-normal">
                    {item.description}
                  </p>
                )}
              </div>
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {item.system_prompt && (
              <div>
                <Label className="text-muted-foreground text-sm">System Prompt</Label>
                <pre className="bg-muted/50 mt-1.5 rounded-md p-3 text-xs leading-relaxed whitespace-pre-wrap">
                  {item.system_prompt}
                </pre>
              </div>
            )}

            {/* Skill tool scope — read-only. Enforced when the skill runs
                unattended in Flows; shown here (system skills included) so the
                scope is visible even where it can't be edited. */}
            {item.category === 'skill' &&
              (() => {
                const labels = skillScopeLabels(item.agent_config)
                return (
                  <div>
                    <Label className="text-muted-foreground text-sm">Tool scope</Label>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {labels.length === 0 ? (
                        <Badge variant="secondary" className="text-xs font-normal">
                          Core tools
                        </Badge>
                      ) : (
                        labels.map((label) => (
                          <Badge key={label} variant="secondary" className="text-xs font-normal">
                            {label}
                          </Badge>
                        ))
                      )}
                    </div>
                    <p className="text-muted-foreground mt-1.5 text-xs">
                      Applies when this skill runs unattended in Flows. In chat, the selected
                      agent&rsquo;s tools apply.
                    </p>
                  </div>
                )
              })()}

            <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
              <VisibilityBadge visibility={item.visibility} />
              {item.fork_count > 0 && (
                <span className="flex items-center gap-1">
                  <Download className="h-3.5 w-3.5" />
                  {item.fork_count} {item.fork_count === 1 ? 'install' : 'installs'}
                </span>
              )}
              {(() => {
                // Same fork-lineage state as the row (one source of truth):
                // "Forked from X" with a "· source has changed" hint when the
                // Discover listing diverged after this copy was added.
                const lineage = lineageChip(item)
                if (!lineage) return null
                return (
                  <span
                    className="flex items-center gap-1"
                    title={
                      lineage.diverged
                        ? 'The Discover listing was updated after you added it'
                        : undefined
                    }
                  >
                    <GitFork className="h-3.5 w-3.5" />
                    Forked from {lineage.sourceName}
                    {lineage.diverged && ' · source has changed'}
                  </span>
                )
              })()}
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            {/* Export a skill to a portable SKILL.md. Only for real workspace
                skill rows (system skills included) — a Discover listing the user
                hasn't added isn't a row this workspace-scoped route can serve. The
                route responds with an attachment disposition, so navigating to it
                triggers a download without leaving the page. */}
            {item.category === 'skill' && (scope !== 'discover' || isMine) && (
              <Button
                variant="outline"
                onClick={() => {
                  window.location.href = `/api/account/skills/${item.id}/export`
                }}
              >
                <Download className="mr-1.5 h-4 w-4" />
                Download SKILL.md
              </Button>
            )}
            {scope === 'discover' && !item.is_system && !isMine && (
              <Button
                onClick={() => {
                  onFork(item.id)
                  onClose()
                }}
                disabled={forking}
              >
                <Download className="mr-1.5 h-4 w-4" />
                Add to Workspace
              </Button>
            )}
            {/* Edit is available on any owned scope, plus the user's own
                Discover listing (don't make them switch tabs to edit it). */}
            {!item.is_system && (scope !== 'discover' || isMine) && (
              <Button
                onClick={() => {
                  onClose()
                  onEdit(item)
                }}
              >
                Edit
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}

// ─── Create / edit dialog ────────────────────────────────────────────

export function EditorDialog({
  open,
  isEditMode,
  form,
  setForm,
  showAdvanced,
  setShowAdvanced,
  saving,
  /**
   * The item's visibility before this edit (or 'workspace' default on create).
   * Used to decide whether a save is a NEW publish that needs confirmation.
   */
  prevVisibility,
  onCancel,
  onSubmit,
}: {
  open: boolean
  isEditMode: boolean
  form: EditorForm
  setForm: React.Dispatch<React.SetStateAction<EditorForm>>
  showAdvanced: boolean
  setShowAdvanced: (v: boolean) => void
  saving: boolean
  prevVisibility: LibraryVisibility
  onCancel: () => void
  onSubmit: () => void
}) {
  // Publish-confirm guardrail (pulled forward from Phase 2): a save that turns
  // an item public for the first time interposes a confirmation so nobody
  // cross-tenant-publishes by accident.
  const [confirmPublish, setConfirmPublish] = useState(false)

  // "Suggest description" (skills only): asks the model to write a routing
  // description from the skill's prompt. Enabled only when there's a prompt to
  // read; overwrites the field so the user can still edit/undo by retyping.
  const [suggesting, setSuggesting] = useState(false)
  const handleSuggestDescription = useCallback(async () => {
    if (suggesting) return
    setSuggesting(true)
    try {
      const res = await fetch('/api/ai/skill-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'description',
          name: form.name.trim() || undefined,
          prompt: form.system_prompt,
        }),
      })
      if (!res.ok) throw new Error('request failed')
      const data = (await res.json()) as { description?: string }
      const description = (data?.description ?? '').trim()
      if (!description) throw new Error('empty description')
      setForm((f) => ({ ...f, description }))
    } catch {
      toast.error("Couldn't suggest a description. Try again.")
    } finally {
      setSuggesting(false)
    }
  }, [suggesting, form.name, form.system_prompt, setForm])

  const isNewPublish = form.visibility === 'public' && prevVisibility !== 'public'

  const handleSaveClick = useCallback(() => {
    if (isNewPublish) {
      setConfirmPublish(true)
      return
    }
    onSubmit()
  }, [isNewPublish, onSubmit])

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {isEditMode ? 'Edit' : 'Create'} {CATEGORY_LABELS[form.category]}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div>
              <Label className="text-muted-foreground text-sm">Name</Label>
              <div className="relative mt-1.5">
                {form.category === 'skill' && (
                  <div className="bg-muted text-muted-foreground pointer-events-none absolute top-1/2 left-2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-xs font-bold">
                    /
                  </div>
                )}
                <Input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder={NAME_PLACEHOLDER[form.category]}
                  style={form.category === 'skill' ? { paddingLeft: 40 } : undefined}
                  autoFocus
                />
              </div>
            </div>

            <div>
              <Label className="text-muted-foreground text-sm">Sharing</Label>
              <Select
                value={form.visibility}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, visibility: v as LibraryVisibility }))
                }
              >
                <SelectTrigger className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">
                    <span className="flex items-center gap-2">
                      <User className="h-3.5 w-3.5" /> Personal
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
            </div>

            <div>
              <div className="flex items-center justify-between">
                <Label className="text-muted-foreground text-sm">Description</Label>
                {/* Skills only: the description doubles as the routing hint, so
                    offer an AI draft from the prompt. Enabled once there's a
                    prompt to summarize; overwrites the field (undo = retype). */}
                {form.category === 'skill' && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-foreground -mr-2 h-6 gap-1 px-2 text-xs"
                    disabled={!form.system_prompt.trim() || suggesting}
                    onClick={handleSuggestDescription}
                    aria-label="Suggest a description from the prompt"
                  >
                    {suggesting ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Sparkles className="h-3 w-3" />
                    )}
                    Suggest
                  </Button>
                )}
              </div>
              <Input
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder={
                  form.category === 'skill'
                    ? 'What does this skill do, and when should it apply?'
                    : 'What does this agent do?'
                }
                className="mt-1.5"
              />
              {/* For skills the description doubles as the ROUTING HINT: chat
                  advertises it to the model, which decides from this line alone
                  whether to auto-load the skill mid-conversation. */}
              {form.category === 'skill' && (
                <p className="text-muted-foreground mt-1.5 text-xs">
                  Chat reads this to decide when to use the skill automatically — be specific
                  about the situations it applies to.
                </p>
              )}
            </div>

            {/* Skills only: the area whose pack loads this skill, so it comes
                up whenever the agent works there (one-agent plan, Part 3). */}
            {form.category === 'skill' && (
              <div>
                <Label className="text-muted-foreground text-sm">Use it whenever I work on</Label>
                <Select
                  value={form.area || NO_AREA}
                  onValueChange={(v) => setForm((f) => ({ ...f, area: v === NO_AREA ? '' : v }))}
                >
                  <SelectTrigger className="mt-1.5" aria-label="Use it whenever I work on">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_AREA}>Nothing in particular</SelectItem>
                    {AREA_OPTIONS.map((a) => (
                      <SelectItem key={a.key} value={a.key}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div>
              <Label className="text-muted-foreground text-sm">Prompt</Label>
              <Textarea
                value={form.system_prompt}
                onChange={(e) => setForm((f) => ({ ...f, system_prompt: e.target.value }))}
                placeholder={
                  form.category === 'skill'
                    ? "Define the skill's behavior and tools…"
                    : "Describe the agent's behavior…"
                }
                rows={6}
                className="mt-1.5"
              />
            </div>

            {form.visibility === 'public' && (
              <p className="text-muted-foreground text-xs">
                This will be visible to all Dial8 users in Discover.
              </p>
            )}

            {/* For agents this section IS the tool allowlist, so it's labeled
                plainly (and the orchestrator opens it by default on create);
                skills keep the generic label for their persona-styling extras. */}
            <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground flex w-full items-center gap-2 text-sm font-medium transition-colors"
                >
                  <ChevronRight
                    className={`h-4 w-4 transition-transform ${showAdvanced ? 'rotate-90' : ''}`}
                  />
                  {form.category === 'agent' ? 'Tool selection' : 'Advanced settings'}
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-4 space-y-4">
                  {form.category === 'skill' && (
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label className="text-muted-foreground text-sm">Icon (emoji)</Label>
                        <Input
                          value={form.icon}
                          onChange={(e) => setForm((f) => ({ ...f, icon: e.target.value }))}
                          placeholder="e.g. 🤖"
                          className="mt-1.5"
                        />
                      </div>
                      <div>
                        <Label className="text-muted-foreground text-sm">Color</Label>
                        <div className="mt-1.5 flex items-center gap-2">
                          <input
                            type="color"
                            value={form.color}
                            onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                            className="h-8 w-8 cursor-pointer rounded border"
                          />
                          <Input
                            value={form.color}
                            onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                            className="flex-1 font-mono text-sm"
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {form.category === 'agent' && (
                    <ToolSelectionTree
                      form={form}
                      setForm={setForm}
                      helperText="This agent can use only the selected tools. Core tools are always available. Leave everything enabled to give the agent all tools."
                    />
                  )}

                  {form.category === 'skill' && (
                    <div>
                      <Label className="text-muted-foreground text-sm">Tool selection</Label>
                      <ToolSelectionTree
                        form={form}
                        setForm={setForm}
                        helperText="Applies when this skill runs unattended in Flows. In chat, the selected agent's tools apply."
                      />
                    </div>
                  )}

                  {form.category === 'skill' && (
                    <div className="grid grid-cols-3 gap-4">
                      <div>
                        <Label className="text-muted-foreground text-sm">Format</Label>
                        <Select
                          value={form.response_format}
                          onValueChange={(v) => setForm((f) => ({ ...f, response_format: v }))}
                        >
                          <SelectTrigger className="mt-1.5">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="concise">Concise</SelectItem>
                            <SelectItem value="detailed">Detailed</SelectItem>
                            <SelectItem value="structured">Structured</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-muted-foreground text-sm">Tone</Label>
                        <Select
                          value={form.response_tone}
                          onValueChange={(v) => setForm((f) => ({ ...f, response_tone: v }))}
                        >
                          <SelectTrigger className="mt-1.5">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="professional">Professional</SelectItem>
                            <SelectItem value="casual">Casual</SelectItem>
                            <SelectItem value="technical">Technical</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-end pb-1">
                        <label className="flex items-center gap-2">
                          <Switch
                            checked={form.always_cite_sources}
                            onCheckedChange={(c) =>
                              setForm((f) => ({ ...f, always_cite_sources: c }))
                            }
                          />
                          <span className="text-sm">Cite sources</span>
                        </label>
                      </div>
                    </div>
                  )}

                  {form.category === 'skill' && (
                    <div>
                      <Label className="text-muted-foreground text-sm">Context Rules</Label>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        Standing instructions the AI follows in this mode.
                      </p>
                      <div className="mt-2 space-y-2">
                        {form.context_rules.map((rule, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <Input
                              value={rule}
                              onChange={(e) => {
                                const rules = [...form.context_rules]
                                rules[i] = e.target.value
                                setForm((f) => ({ ...f, context_rules: rules }))
                              }}
                              placeholder="e.g., Always check overdue actions first"
                              className="h-8"
                            />
                            {form.context_rules.length > 1 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0"
                                onClick={() =>
                                  setForm((f) => ({
                                    ...f,
                                    context_rules: f.context_rules.filter((_, j) => j !== i),
                                  }))
                                }
                              >
                                <Trash2 className="text-muted-foreground h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        ))}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setForm((f) => ({ ...f, context_rules: [...f.context_rules, ''] }))
                          }
                        >
                          <Plus className="mr-1 h-3.5 w-3.5" />
                          Add Rule
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={handleSaveClick} disabled={saving || !form.name.trim()}>
              {saving ? (isEditMode ? 'Saving…' : 'Creating…') : isEditMode ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Publish-confirm guardrail — only shown when a save would flip an item
          public for the first time. Confirm proceeds with the save; cancel
          returns to the editor with visibility unchanged. */}
      <AlertDialog open={confirmPublish} onOpenChange={setConfirmPublish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish to all Dial8 users?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This {CATEGORY_LABELS[form.category].toLowerCase()} will appear in Discover for
                  every Dial8 user, across all workspaces.
                </p>
                <p>Your name and avatar are shown as the author.</p>
                <p>
                  The prompt itself stays hidden until someone adds it to their workspace.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmPublish(false)
                onSubmit()
              }}
            >
              Publish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
