/**
 * Which skills' eval cases a change should run (docs/plans/always-on-agent.md
 * §8: "a change to a skill or to the instructions runs them").
 * scripts/skill-evals-changed.ts feeds it `git diff` and prints the
 * CHAT_SKILL_EVAL_ONLY list. Pure.
 *
 *   cases/<slug>.ts                  that skill;
 *   cases/flywheel.json              the skills its changed lines name;
 *   a migration                      every skill with cases whose slug its
 *                                    changed lines mention (the system skills
 *                                    are seeded and rewritten in migrations);
 *   the instructions, the skills     `instructions`: the core subset (the first
 *   loader, the packs, the judge     cases of every skill, plus the flywheel's
 *                                    instruction cases; selectSkillEvalSuites).
 *
 * A selected skill's flywheel cases run with it (they sit in its suite).
 */
import { INSTRUCTIONS_SUITE } from './index'

const CASES_DIR = 'src/lib/packs/skill-evals/cases/'
const FLYWHEEL_FILE = `${CASES_DIR}flywheel.json`
const MIGRATIONS_DIR = 'supabase/migrations/'

/**
 * Files whose change can move every skill: the chat agent's instructions, the
 * skills loader (load_skill and its matching), the packs and the eval judge.
 * A path ending in `/` covers its directory (not the cases, which map by slug).
 */
export const INSTRUCTIONS_PATHS: readonly string[] = [
  'agents/chat-agent/instructions.md',
  'agents/chat-agent/instructions/',
  'agents/chat-agent/tools/workspace_tools.ts',
  'agents/chat-agent/lib/skill-match.ts',
  'agents/chat-agent/lib/expertise.ts',
  'src/lib/packs/skill-evals/index.ts',
  'src/lib/packs/skill-evals/types.ts',
]

/** The packs themselves: any `src/lib/packs/<file>.ts` (not a subdirectory, not a test). */
const PACK_FILE_RE = /^src\/lib\/packs\/[^/]+\.ts$/

export interface ChangedSkillEvals {
  /** The skills to run in full, sorted. */
  slugs: string[]
  /** Whether the `instructions` core subset runs too. */
  instructions: boolean
  /** Why each was picked: the file, and what it selected. */
  reasons: Array<{ file: string; selects: string }>
}

function isInstructionsPath(file: string): boolean {
  if (PACK_FILE_RE.test(file) && !file.endsWith('.test.ts')) return true
  return INSTRUCTIONS_PATHS.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p))
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Slugs a line mentions as a whole word (a slug's neighbours are not letters, digits or dashes). */
function slugsIn(lines: readonly string[], slugs: readonly string[]): string[] {
  const text = lines.join('\n')
  return slugs.filter((slug) => new RegExp(`(?<![a-z0-9-])${escapeRe(slug)}(?![a-z0-9-])`).test(text))
}

/**
 * The skills a change selects.
 * @param files        changed paths (`git diff --name-only`), repo-relative
 * @param changedLines added and removed lines per file, for migrations and flywheel.json
 * @param caseSlugs    the skills that have cases (file or flywheel suites)
 */
export function skillEvalsForChange(
  files: readonly string[],
  changedLines: Readonly<Record<string, readonly string[]>>,
  caseSlugs: readonly string[],
): ChangedSkillEvals {
  const slugs = new Set<string>()
  const reasons: ChangedSkillEvals['reasons'] = []
  let instructions = false
  // `instructions` is a suite key, never a word to look for in a migration.
  const matchable = caseSlugs.filter((s) => s !== INSTRUCTIONS_SUITE)
  const pick = (file: string, slug: string) => {
    if (slug === INSTRUCTIONS_SUITE) instructions = true
    else slugs.add(slug)
    reasons.push({ file, selects: slug })
  }

  for (const file of files) {
    if (file === FLYWHEEL_FILE) {
      const named = new Set<string>()
      for (const line of changedLines[file] ?? []) {
        const m = /"skill"\s*:\s*"([^"]+)"/.exec(line)
        if (m) named.add(m[1])
      }
      for (const slug of named) pick(file, slug)
      continue
    }
    const caseFile = file.startsWith(CASES_DIR) ? /^([a-z0-9-]+)\.ts$/.exec(file.slice(CASES_DIR.length)) : null
    if (caseFile) {
      pick(file, caseFile[1])
      continue
    }
    if (file.startsWith(MIGRATIONS_DIR) && file.endsWith('.sql')) {
      for (const slug of slugsIn(changedLines[file] ?? [], matchable)) pick(file, slug)
      continue
    }
    if (isInstructionsPath(file)) pick(file, INSTRUCTIONS_SUITE)
  }

  return { slugs: [...slugs].sort(), instructions, reasons }
}

/** The CHAT_SKILL_EVAL_ONLY value: the slugs, then `instructions` when the core subset runs. */
export function onlyList(changed: ChangedSkillEvals): string {
  return [...changed.slugs, ...(changed.instructions ? [INSTRUCTIONS_SUITE] : [])].join(',')
}

/**
 * The added and removed lines per file of a `git diff -U0`: the hunks'
 * `+`/`-` lines, without the marker.
 */
export function changedLinesFromDiff(diff: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  let file: string | null = null
  // Between `diff --git` and the first `@@` sit the headers: a removed SQL
  // comment (`--- note`) inside a hunk is a line, not a header.
  let inHunk = false
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (header) {
      file = header[2]
      out[file] ??= []
      inHunk = false
      continue
    }
    if (!file) continue
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (inHunk && (line.startsWith('+') || line.startsWith('-'))) out[file].push(line.slice(1))
  }
  return out
}
