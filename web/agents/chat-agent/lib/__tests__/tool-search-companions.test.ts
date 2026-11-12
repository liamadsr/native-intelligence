/**
 * A search that finds a Studio tool also brings wait_for_studio_job (../tool-search.ts): the tools that start work on
 * the Studio worker answer a job, and without the wait tool the model can only check the job a few times and give up.
 * The companion comes only from the searched set, so it never widens what a run may call.
 */
import { describe, it, expect } from 'vitest'
import { COMPANION_TOOLS, SEARCH_RESULT_LIMIT, rankTools, withCompanions } from '../tool-search'

const tool = (name: string, description: string) => ({ name, description })
const WAIT = tool('wait_for_studio_job', 'Wait for a Studio job to finish, then its result')
const JUDGE = tool('judge_studio_sound', 'Measure sounds against a description')

describe('search_tools brings a companion tool', () => {
  it('a search that finds a Studio tool also returns wait_for_studio_job, even when its own words did not match', () => {
    const found = rankTools('judge sound', [JUDGE, WAIT, tool('list_emails', 'List the inbox')])
    expect(found.map((t) => t.name)).toEqual(['judge_studio_sound', 'wait_for_studio_job'])
  })

  it('comes on top of a full page of results, once', () => {
    const many = Array.from({ length: 30 }, (_, i) => tool(`list_studio_thing_${i}`, 'A made-up Studio list'))
    const found = rankTools('studio list', [...many, WAIT])
    expect(found.length).toBeLessThanOrEqual(SEARCH_RESULT_LIMIT + COMPANION_TOOLS.length)
    expect(found.filter((t) => t.name === WAIT.name)).toHaveLength(1)
  })

  it('never appears when the searched set does not hold it (a run whose ceiling leaves it out), or when nothing Studio was found', () => {
    expect(rankTools('judge sound', [JUDGE]).map((t) => t.name)).toEqual(['judge_studio_sound'])
    expect(rankTools('inbox', [tool('list_emails', 'List the inbox'), WAIT]).map((t) => t.name)).toEqual(['list_emails'])
    expect(withCompanions([], [WAIT])).toEqual([])
  })
})
