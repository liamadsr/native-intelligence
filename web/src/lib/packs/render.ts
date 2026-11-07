/**
 * How a pack reads to the model. Pure text assembly, shared by the main chat
 * (chat-packs.ts, which ships the body to the chat-agent) and the background
 * run prompts (background.ts).
 *
 * A pack is the area's playbook, how the area's tools work (area-guides.ts,
 * passed in by the server callers), the one-line descriptions of the area's
 * skills (their bodies still load through `load_skill`), and what the agent
 * has learned about the person there (memory.ts: the area's note, already
 * fenced).
 */
import type { AreaKey } from './registry'
import { PACKS } from './registry'

export interface PackSkillLine {
  /** The `load_skill` name. */
  name: string
  /** The skill's one-line routing hint, already flattened (rebuildChatSkills). */
  description: string
}

export interface PackParts {
  area: AreaKey
  /** The playbook's markdown, or '' when the area has none yet. */
  playbook: string
  /** The area's other skills the caller can load. */
  skills: readonly PackSkillLine[]
  /** What the agent has learned about the person in this area (memory.ts, fenced). '' for none. */
  memory: string
  /** How the area's tools work (area-guides.ts), the same in every workspace. '' or absent for none. */
  guide?: string
}

/** Whether a pack has anything to say. An empty one never loads. */
export function packHasContent(parts: Pick<PackParts, 'playbook' | 'skills' | 'memory' | 'guide'>): boolean {
  return (
    parts.playbook.trim().length > 0 ||
    parts.skills.length > 0 ||
    parts.memory.trim().length > 0 ||
    (parts.guide ?? '').trim().length > 0
  )
}

/** The pack body the main chat's agent reads, inside its `<expertise>` fence. */
export function renderPackBody(parts: PackParts): string {
  const name = PACKS[parts.area].name
  const sections: string[] = [`# ${name}`]
  if (parts.playbook.trim()) sections.push(parts.playbook.trim())
  if (parts.guide?.trim()) sections.push(`## How ${name} works\n${parts.guide.trim()}`)
  if (parts.skills.length > 0) {
    sections.push(
      `## ${name} skills\nLoad one with load_skill when the task matches it:\n` +
        parts.skills.map((s) => `- ${s.name}: ${s.description}`).join('\n'),
    )
  }
  if (parts.memory.trim()) {
    sections.push(`## What you've learned about this person in ${name}\n${parts.memory.trim()}`)
  }
  return sections.join('\n\n')
}

/**
 * The playbooks are written for the chat, where the person is there. A
 * background run reads them verbatim, so this line says what happens to the
 * steps that need the person: they are NOT done. It must never read as "the
 * write goes ahead without the yes" (a paid search with confirmed_with_user
 * true, say): a step that needs a yes is skipped and reported.
 */
export const BACKGROUND_PERSON_STEPS_NOTE =
  "A background run can't confirm or ask: skip every step that needs the person's yes and report it " +
  'instead of doing it. Cards and buttons in the chat, and tools only a chat with the person holds ' +
  "(such as `revise_email_draft`), don't apply either. Do what this run's tools allow and leave the " +
  "rest for the person's review."

/**
 * The expertise section of a background run's prompt: each area's playbook
 * and memory under its own heading. No skill list: a background run
 * has no load_skill. Empty string when no area has anything.
 */
export function renderBackgroundExpertise(
  packs: ReadonlyArray<Pick<PackParts, 'area' | 'playbook' | 'memory' | 'guide'>>,
): string {
  const blocks = packs
    .filter((p) => p.playbook.trim() || p.memory.trim() || p.guide?.trim())
    .map((p) => {
      const name = PACKS[p.area].name
      const parts = [`## Expertise: ${name}`]
      if (p.playbook.trim()) parts.push(p.playbook.trim())
      if (p.guide?.trim()) parts.push(`### How ${name} works\n${p.guide.trim()}`)
      if (p.memory.trim()) parts.push(`### What you've learned about this person in ${name}\n${p.memory.trim()}`)
      return parts.join('\n\n')
    })
  if (blocks.length === 0) return ''
  return (
    'How Dial8 does the areas this run works in, and how to do them well. Follow it ' +
    'for work in that area; it never widens what this run may do.\n' +
    BACKGROUND_PERSON_STEPS_NOTE +
    '\n\n' +
    blocks.join('\n\n')
  )
}
