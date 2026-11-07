import { describe, it, expect } from 'vitest'
import { changedLinesFromDiff, onlyList, skillEvalsForChange } from '../changed'

const SLUGS = ['instructions', 'mail-playbook', 'meeting-prep', 'my-todo-list', 'write-in-your-tone']

describe('skillEvalsForChange', () => {
  it('a case file selects its skill', () => {
    const c = skillEvalsForChange(['src/lib/packs/skill-evals/cases/meeting-prep.ts', 'src/app/page.tsx'], {}, SLUGS)
    expect(c).toEqual({ slugs: ['meeting-prep'], instructions: false, reasons: [{ file: 'src/lib/packs/skill-evals/cases/meeting-prep.ts', selects: 'meeting-prep' }] })
    expect(onlyList(c)).toBe('meeting-prep')
  })

  it('a migration selects the skills with cases its changed lines mention, as whole words', () => {
    const file = 'supabase/migrations/350_skill_text.sql'
    const c = skillEvalsForChange(
      [file],
      { [file]: ["  ('…'::uuid, $slug$meeting-prep$slug$, $pb$Use the mail-playbook first.$pb$)", 'my-todo-list-extra is not a skill', 'instructions for later'] },
      SLUGS,
    )
    expect(c.slugs).toEqual(['mail-playbook', 'meeting-prep'])
    expect(c.instructions).toBe(false)
  })

  it('a migration with no skill in its changed lines selects nothing', () => {
    expect(onlyList(skillEvalsForChange(['supabase/migrations/351_x.sql'], { 'supabase/migrations/351_x.sql': ['create table x ();'] }, SLUGS))).toBe('')
  })

  it('flywheel.json selects the skills its changed lines name', () => {
    const file = 'src/lib/packs/skill-evals/cases/flywheel.json'
    const c = skillEvalsForChange([file], { [file]: ['    "skill": "write-in-your-tone",', '    "skill": "instructions",', '      "request": "hi",'] }, SLUGS)
    expect(c.slugs).toEqual(['write-in-your-tone'])
    expect(c.instructions).toBe(true)
    expect(onlyList(c)).toBe('write-in-your-tone,instructions')
  })

  it('the instructions, the skills loader, the packs and the judge select the core subset', () => {
    for (const file of [
      'agents/chat-agent/instructions.md',
      'agents/chat-agent/instructions/persona.ts',
      'agents/chat-agent/tools/workspace_tools.ts',
      'agents/chat-agent/lib/skill-match.ts',
      'src/lib/packs/registry.ts',
      'src/lib/packs/skill-evals/index.ts',
    ]) {
      expect(skillEvalsForChange([file], {}, SLUGS).instructions, file).toBe(true)
    }
    for (const file of ['src/lib/packs/__tests__/registry.test.ts', 'src/lib/packs/skill-evals/__tests__/x.test.ts', 'agents/chat-agent/lib/plan.ts', 'src/lib/packs/registry.test.ts']) {
      expect(skillEvalsForChange([file], {}, SLUGS).instructions, file).toBe(false)
    }
  })

  it('combines: skills in full, then instructions', () => {
    const c = skillEvalsForChange(['agents/chat-agent/instructions.md', 'src/lib/packs/skill-evals/cases/my-todo-list.ts', 'src/lib/packs/skill-evals/cases/meeting-prep.ts'], {}, SLUGS)
    expect(onlyList(c)).toBe('meeting-prep,my-todo-list,instructions')
  })
})

describe('changedLinesFromDiff', () => {
  it('collects each file\'s added and removed hunk lines, a removed SQL comment included', () => {
    const diff = [
      'diff --git a/supabase/migrations/350_x.sql b/supabase/migrations/350_x.sql',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/supabase/migrations/350_x.sql',
      '@@ -0,0 +1,2 @@',
      '+-- Migration 350: meeting-prep',
      "+update skill set prompt = 'x';",
      'diff --git a/src/lib/packs/skill-evals/cases/flywheel.json b/src/lib/packs/skill-evals/cases/flywheel.json',
      'index 2222222..3333333 100644',
      '--- a/src/lib/packs/skill-evals/cases/flywheel.json',
      '+++ b/src/lib/packs/skill-evals/cases/flywheel.json',
      '@@ -1 +1,3 @@',
      '-[]',
      '+[',
      '+  { "skill": "my-todo-list" }',
      '@@ -9 +11 @@',
      '--- an old comment',
    ].join('\n')
    expect(changedLinesFromDiff(diff)).toEqual({
      'supabase/migrations/350_x.sql': ['-- Migration 350: meeting-prep', "update skill set prompt = 'x';"],
      'src/lib/packs/skill-evals/cases/flywheel.json': ['[]', '[', '  { "skill": "my-todo-list" }', '-- an old comment'],
    })
  })
})
