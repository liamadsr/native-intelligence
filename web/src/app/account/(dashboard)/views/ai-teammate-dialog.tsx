'use client'

/**
 * Add, or edit, an AI teammate on a team (the Teams panel): its name and the
 * persona it's built on.
 *
 *   - Adding: it starts with its agent's skills.
 *   - Editing (`member`): seeded from the teammate, and only what changed is
 *     sent. A system teammate's persona is fixed (the route answers 409), so
 *     its persona select is disabled; its name and skills change like
 *     anyone's.
 *
 * Skills (bots-v4 B1, decision 11): a teammate's skills are its agent's,
 * shared by every agent on it, so they change in the one agent editor ("Open
 * the editor"), under the agent's rule. Only a system teammate, its own
 * agent, keeps its checklist here: up to five, shared skills only.
 *
 * Errors from the routes, RLS's included (only workspace admins and the
 * team's leads may add or edit), show in the dialog.
 *
 * What the editor can't read stays as it is: another creator's `personal`
 * persona or skill is hidden from them (recipe_select_visibility), so the GET
 * names none of it but hands back its ids. The persona shows as "Private
 * persona", selected, until the editor picks another; a private skill is kept
 * in the skills sent back (a full replace would otherwise drop it) and counted
 * under the list.
 *
 * Header and footer stay put on a short window: only the body scrolls.
 */
import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { Check, Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { LibraryItemIcon } from '@/components/library-item-icon'
import { announceTeammatesChanged } from '@/lib/bots/teammates-changed'
import { MAX_PINNED_SKILLS } from '@/lib/agents/editable-fields'

/** The one agent editor, loaded when "Open the editor" is pressed. */
const AgentEditorDialog = lazy(() => import('@/components/agents/agent-editor').then((m) => ({ default: m.AgentEditorDialog })))

export interface LibraryRef {
  id: string
  name: string
  icon: string | null
  color: string | null
  /** A personal recipe is its author's alone: never one an agent always checks. */
  visibility?: string | null
}

/** The teammate being edited, as the ai-members GET returns it. */
export interface EditableAiMember {
  id: string
  name: string
  is_system?: boolean
  /** A loop's work agent (migration 302): its persona is the work-agent anchor, fixed. */
  fronts_only?: boolean
  agent: LibraryRef | null
  skills: LibraryRef[]
  /** The persona it's built on, readable or not (`agent` is null where the editor can't read it). */
  agent_recipe_id?: string | null
  /** Its skills in order, readable or not (`skills` names only the readable ones). */
  skill_recipe_ids?: string[]
}

/** Stands in for a persona the editor can't read, so the select shows the teammate has one. */
const PRIVATE_PERSONA_NAME = 'Private persona'

function sameSet(a: ReadonlySet<string>, b: readonly string[]): boolean {
  return a.size === b.length && b.every((id) => a.has(id))
}

export function AiTeammateDialog({
  teamId,
  member,
  onClose,
  onSaved,
}: {
  teamId: string
  /** Set: edit this teammate. Unset: add a new one. */
  member?: EditableAiMember
  onClose: () => void
  onSaved: () => void
}) {
  const editing = !!member
  const workBot = member?.fronts_only === true
  const personaLocked = !!member?.is_system || workBot
  // Only a system teammate's skills change here; any other agent's are its agent's.
  const ownsSkills = !!member?.is_system
  const [customizing, setCustomizing] = useState(false)
  // A persona the editor can't read (another creator's personal one): kept
  // selected, never cleared, until they pick another.
  const privatePersonaId =
    member && !member.is_system && !workBot && !member.agent && member.agent_recipe_id ? member.agent_recipe_id : null
  // Skills it has that the editor can't read: sent back untouched.
  const privateSkillIds = useMemo(() => {
    if (!member?.skill_recipe_ids) return []
    const readable = new Set(member.skills.map((s) => s.id))
    return member.skill_recipe_ids.filter((id) => !readable.has(id))
  }, [member])

  const [agents, setAgents] = useState<LibraryRef[]>([])
  const [skills, setSkills] = useState<LibraryRef[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [name, setName] = useState(member?.name ?? '')
  const [agentId, setAgentId] = useState(member?.agent?.id ?? privatePersonaId ?? '')
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(
    () => new Set(member?.skills.map((s) => s.id) ?? []),
  )

  useEffect(() => {
    Promise.all([fetch('/api/account/agents'), fetch('/api/account/skills')]).then(async ([aRes, sRes]) => {
      if (aRes.ok) setAgents((await aRes.json()).agents || [])
      if (sRes.ok) setSkills((await sRes.json()).skills || [])
      setLoading(false)
    })
  }, [])

  // The teammate's own persona and skills stay listed even when the library
  // lists don't carry them, so the select and the checkboxes show what it has.
  // A personal agent has no teammate (bots-v4 B1): none is offered, though one a
  // teammate already has stays shown as its own.
  const agentOptions = useMemo(() => {
    const own =
      member?.agent ??
      (privatePersonaId ? { id: privatePersonaId, name: PRIVATE_PERSONA_NAME, icon: null, color: null } : null)
    const offered = agents.filter((a) => a.visibility !== 'personal' || a.id === own?.id)
    return own && !offered.some((a) => a.id === own.id) ? [own, ...offered] : offered
  }, [agents, member?.agent, privatePersonaId])
  const skillOptions = useMemo(() => {
    const missing = (member?.skills ?? []).filter((s) => !skills.some((k) => k.id === s.id))
    // A personal skill can't be one an agent always checks (bots-v4 B1).
    return [...missing, ...skills.filter((k) => k.visibility !== 'personal')]
  }, [skills, member?.skills])

  function toggleSkill(id: string) {
    setSelectedSkillIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else if (next.size + privateSkillIds.length < MAX_PINNED_SKILLS) next.add(id)
      return next
    })
  }

  /** What an edit changes, field by field: only these are sent. */
  function changes(m: EditableAiMember): Record<string, unknown> {
    const body: Record<string, unknown> = {}
    const trimmed = name.trim()
    if (trimmed && trimmed !== m.name) body.name = trimmed
    if (!m.is_system && m.fronts_only !== true && agentId && agentId !== (m.agent?.id ?? m.agent_recipe_id ?? '')) body.agent_recipe_id = agentId
    if (m.is_system && !sameSet(selectedSkillIds, m.skills.map((s) => s.id))) {
      // A full replace: what it had stays in its order, the private skills
      // included, less what was unticked; what was ticked follows.
      const had = m.skill_recipe_ids ?? m.skills.map((s) => s.id)
      const kept = had.filter((id) => selectedSkillIds.has(id) || privateSkillIds.includes(id))
      body.skill_recipe_ids = [...kept, ...[...selectedSkillIds].filter((id) => !kept.includes(id))]
    }
    return body
  }

  const pending = member ? changes(member) : null
  const canSave = editing
    ? !!name.trim() && Object.keys(pending ?? {}).length > 0
    : !!name.trim() && !!agentId

  async function handleSave() {
    if (!canSave || saving) return
    setSaving(true)
    setError('')
    const res = member
      ? await fetch(`/api/account/teams/${teamId}/ai-members/${member.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(changes(member)),
        })
      : await fetch(`/api/account/teams/${teamId}/ai-members`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Its skills are its agent's: it starts with them (decision 11).
          body: JSON.stringify({ name: name.trim(), agent_recipe_id: agentId }),
        })
    if (res.ok) {
      // It shows under Agents now.
      announceTeammatesChanged()
      onSaved()
    } else {
      const fallback = editing ? 'Failed to save the agent' : 'Failed to create the agent'
      setError((await res.json().catch(() => null))?.error || fallback)
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-lg flex-col" aria-describedby={undefined}>
        <DialogHeader className="shrink-0">
          <DialogTitle>{editing ? 'Edit agent' : 'Add an agent'}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="shrink-0 space-y-3 py-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <div className="-mx-6 min-h-0 space-y-4 overflow-y-auto px-6 py-1">
            <div className="space-y-1.5">
              <Label className="text-xs">Name</Label>
              <Input
                placeholder="e.g. Riley (PM)"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                This teammate&apos;s own name — shown on the team, distinct from the agent it&apos;s built on.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Persona</Label>
              <Select value={agentId} onValueChange={setAgentId} disabled={personaLocked}>
                <SelectTrigger>
                  <SelectValue placeholder={workBot ? 'Its loops' : personaLocked ? 'Built-in loop' : 'Pick a persona...'} />
                </SelectTrigger>
                <SelectContent>
                  {agentOptions.length === 0 ? (
                    <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                      No personas yet — create one in Personas.
                    </div>
                  ) : (
                    agentOptions.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        <span className="flex items-center gap-2">
                          <LibraryItemIcon color={a.color} seed={a.id} size="xs" />
                          {a.name}
                        </span>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {personaLocked && (
                <p className="text-[11px] text-muted-foreground">
                  {workBot
                    ? 'This agent speaks for the loops it fronts, so it has no persona to change.'
                    : "A built-in agent runs a built-in loop, so its persona can't change."}
                </p>
              )}
              {privatePersonaId && agentId === privatePersonaId && (
                <p className="text-[11px] text-muted-foreground">
                  Built on a persona only its creator can see. It stays unless you pick another.
                </p>
              )}
            </div>

            {ownsSkills ? (
              <div className="space-y-1.5" data-teammate-skills="own">
                <Label className="text-xs">Skills it always checks</Label>
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                  {skillOptions.length === 0 ? (
                    <p className="px-1 py-2 text-center text-xs text-muted-foreground">
                      No skills yet — create some in Personas.
                    </p>
                  ) : (
                    skillOptions.map((s) => {
                      const on = selectedSkillIds.has(s.id)
                      const full = !on && selectedSkillIds.size + privateSkillIds.length >= MAX_PINNED_SKILLS
                      return (
                        <label
                          key={s.id}
                          className={`flex items-center gap-2 rounded px-1.5 py-1 ${full ? 'opacity-50' : 'cursor-pointer hover:bg-muted/60'}`}
                        >
                          <Checkbox checked={on} disabled={full} onCheckedChange={() => toggleSkill(s.id)} />
                          <LibraryItemIcon color={s.color} seed={s.id} size="xs" />
                          <span className="text-sm">{s.name}</span>
                        </label>
                      )
                    })
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {selectedSkillIds.size + privateSkillIds.length} of {MAX_PINNED_SKILLS}
                </p>
                {privateSkillIds.length > 0 && (
                  <p className="text-[11px] text-muted-foreground" data-private-skills={privateSkillIds.length}>
                    {privateSkillIds.length === 1
                      ? 'Also has 1 private skill only its creator can see. It stays as it is.'
                      : `Also has ${privateSkillIds.length} private skills only their creators can see. They stay as they are.`}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-1.5" data-teammate-skills="agent">
                <Label className="text-xs">Skills it always checks</Label>
                {editing && member && member.skills.length > 0 && (
                  <p className="text-sm">{member.skills.map((s) => s.name).join(', ')}</p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  {!editing
                    ? 'It starts with its persona’s skills. They change in the persona’s editor, for every agent on it.'
                    : workBot && !member?.agent
                      ? 'A loop’s agent runs its loops’ skills. Change them in the loop.'
                      : 'Its skills are its persona’s, shared by every agent on it. Change them in the persona’s editor.'}
                </p>
                {editing && member && !(workBot && !member.agent) && (
                  <Button type="button" variant="outline" size="sm" data-open-agent-editor="" onClick={() => setCustomizing(true)}>
                    Open the editor
                  </Button>
                )}
              </div>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        {/* The one agent editor, on this teammate (its agent's skills, instructions and tools). */}
        {member && customizing && (
          <Suspense fallback={null}>
            <AgentEditorDialog open teammateId={member.id} onClose={() => setCustomizing(false)} onSaved={() => onSaved()} />
          </Suspense>
        )}

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={!canSave || saving}>
            {saving ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : editing ? (
              <Check className="mr-1 h-3 w-3" />
            ) : (
              <Plus className="mr-1 h-3 w-3" />
            )}
            {editing ? 'Save' : 'Add to team'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
