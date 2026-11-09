import { requireWorkspace } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { normalizeSlug } from '@/lib/library/slug'
import { serializeSkillMd } from '@/lib/library/skill-md'
import type { AgentConfig } from '@/lib/types/library'

/**
 * GET /api/account/skills/[id]/export
 *
 * Export a Skill as a portable Anthropic SKILL.md file — the "take your skill
 * to any agent runtime" surface. The frontmatter carries only the standard
 * `name`/`description`; the system prompt becomes the instructions body, and
 * NI-specific config (standing instructions, response style) is folded in as
 * prose sections so the file stays portable to any SKILL.md consumer.
 *
 * Runs under the caller's RLS client with the same workspace scoping as the
 * sibling skill routes, so a skill the caller can't see comes back as no row →
 * 404 (indistinguishable from a wrong-category id, by design).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { id } = await params

  // RLS-filtered + house-visibility + category-guarded: a foreign non-system,
  // invisible, or non-skill row all come back null. The visibility clause mirrors
  // listLibraryItems in src/lib/library/queries.ts — system skills (is_system=true,
  // workspace_id NULL/foreign) plus the workspace's own skills — so the export
  // surface matches what the library page shows. Without it, built-ins 404 here.
  const { data: skill, error } = await supabase
    .from('recipe')
    .select('name, slug, description, system_prompt, agent_config')
    .eq('id', id)
    .eq('category', 'skill')
    .or(`is_system.eq.true,workspace_id.eq.${workspaceId}`)
    .maybeSingle()

  if (error) return serverError(error.message)
  if (!skill) return notFound('Skill not found')

  const config = (skill.agent_config ?? {}) as AgentConfig
  const slug = skill.slug || normalizeSlug(skill.name || '') || 'skill'

  const extraSections: Array<{ heading: string; lines: string[] }> = []

  // Standing instructions → one bullet per rule (mirrors how recipe-prompt.ts
  // renders context_rules into the live persona).
  if (Array.isArray(config.context_rules) && config.context_rules.length) {
    const lines = config.context_rules
      .map((r) => String(r).trim())
      .filter(Boolean)
      .map((r) => `- ${r}`)
    if (lines.length) {
      extraSections.push({ heading: 'Standing instructions', lines })
    }
  }

  // Response style → plain prose lines for whichever fields are set.
  const style = config.response_style
  if (style && (style.format || style.tone || style.always_cite_sources)) {
    const lines: string[] = []
    if (style.format) lines.push(`Respond in ${style.format} format.`)
    if (style.tone) lines.push(`Use a ${style.tone} tone.`)
    if (style.always_cite_sources) lines.push('Always cite your sources.')
    if (lines.length) {
      extraSections.push({ heading: 'Response style', lines })
    }
  }

  const text = serializeSkillMd({
    slug,
    description: skill.description ?? '',
    body: skill.system_prompt ?? '',
    extraSections,
  })

  return new Response(text, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${slug}.SKILL.md"`,
    },
  })
}
