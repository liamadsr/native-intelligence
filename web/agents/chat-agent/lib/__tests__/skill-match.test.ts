import { describe, it, expect } from 'vitest'
import { listedSkillNames, matchSkill, MAX_LISTED_SKILLS } from '../skill-match'

const skills = [
  { name: 'actions-playbook' },
  { name: 'overdue-work' },
  { name: 'actions-weekly' },
  { name: 'my-todo-list' },
  { name: 'Weekly Planner' },
]

const name = (r: ReturnType<typeof matchSkill>) => (r.kind === 'match' ? r.skill.name : r.kind)

describe('matchSkill (load_skill)', () => {
  it('an exact name wins, case-insensitively', () => {
    expect(name(matchSkill(skills, 'overdue-work'))).toBe('overdue-work')
    expect(name(matchSkill(skills, '  MY-TODO-LIST '))).toBe('my-todo-list')
    expect(name(matchSkill(skills, 'weekly planner'))).toBe('Weekly Planner')
  })

  it('then `<x>-playbook`: an area name stays its pack even when other skills contain it', () => {
    // "actions" is a substring of two skills; without the playbook step it would be ambiguous.
    expect(name(matchSkill(skills, 'actions'))).toBe('actions-playbook')
    expect(name(matchSkill(skills, 'Actions'))).toBe('actions-playbook')
  })

  it('then a unique substring', () => {
    expect(name(matchSkill(skills, 'overdue'))).toBe('overdue-work')
    expect(name(matchSkill(skills, 'todo'))).toBe('my-todo-list')
  })

  it('two or more substring hits are ambiguous and name every candidate', () => {
    expect(matchSkill(skills, 'weekly')).toEqual({ kind: 'ambiguous', names: ['actions-weekly', 'Weekly Planner'] })
  })

  it('then the name with spaces, hyphens and underscores ignored', () => {
    expect(name(matchSkill(skills, 'my to-do list'))).toBe('my-todo-list')
    expect(name(matchSkill(skills, 'My To Do List'))).toBe('my-todo-list')
    expect(name(matchSkill(skills, 'Overdue work'))).toBe('overdue-work')
    expect(name(matchSkill(skills, 'overdue_work'))).toBe('overdue-work')
    expect(name(matchSkill(skills, 'weekly-planner'))).toBe('Weekly Planner')
    expect(name(matchSkill(skills, 'actions playbook'))).toBe('actions-playbook')
  })

  it('two names equal once punctuation is ignored are ambiguous', () => {
    expect(matchSkill([{ name: 'deal-review' }, { name: 'Deal Review' }], 'deal_review')).toEqual({
      kind: 'ambiguous',
      names: ['deal-review', 'Deal Review'],
    })
  })

  it('a name with no letters or digits still matches itself', () => {
    expect(name(matchSkill([{ name: '🚀' }, { name: 'launch' }], '🚀'))).toBe('🚀')
  })

  it('nothing, or an empty request, is no match', () => {
    expect(matchSkill(skills, 'invoices')).toEqual({ kind: 'none' })
    expect(matchSkill(skills, '   ')).toEqual({ kind: 'none' })
    expect(matchSkill([{ name: 'only' }], '')).toEqual({ kind: 'none' })
  })
})

describe('listedSkillNames (the unknown-skill error)', () => {
  it('lists every name when there are few', () => {
    expect(listedSkillNames(skills)).toEqual({ available: skills.map((s) => s.name) })
  })

  it(`caps the list at ${MAX_LISTED_SKILLS} and says how many more`, () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ name: `skill-${i}` }))
    const listed = listedSkillNames(many)
    expect(listed.available).toHaveLength(MAX_LISTED_SKILLS)
    expect(listed.available[0]).toBe('skill-0')
    expect(listed.more).toBe(100 - MAX_LISTED_SKILLS)
  })
})
