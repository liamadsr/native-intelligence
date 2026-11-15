/**
 * Who a worker's manager is, in the texts the bundle gives it
 * (instructions.ts, manager-tools.ts): the Native Intelligence agent, or the
 * person themselves when they started the job from their chat's Code tab
 * (the server's claim then says so before the request). Either way, a
 * question ends the turn WITHOUT `finish`, and the job waits for the answer
 * (the driver never nudges a turn that asked: driver.test.ts).
 */
import { describe, expect, it } from 'vitest'
import { WORKER_INSTRUCTIONS } from '../lib/instructions'
import { MANAGER_TOOLS } from '../lib/manager-tools'

const tool = (name: string) => MANAGER_TOOLS.find((t) => t.name === name)!

describe('the manager, in the worker’s texts', () => {
  it('the instructions: the person may be the manager (the request says so); after a question, no finish, wait; never "waiting on" anyone else', () => {
    expect(WORKER_INSTRUCTIONS).toContain('or the person themselves when they started this job from their chat\'s Code tab')
    expect(WORKER_INSTRUCTIONS).toContain('end your turn without calling `finish`, and wait')
    expect(WORKER_INSTRUCTIONS).toContain('never write that you asked, or are waiting on, anyone else')
  })

  it('ask_manager asks the person when they started the job, and the turn waits without finish', () => {
    expect(tool('ask_manager').description).toContain('or the person when they started this job themselves')
    expect(tool('ask_manager').description).toContain('end your turn without calling finish, and wait')
    expect(tool('ask_manager').description).not.toMatch(/^Ask the Native Intelligence agent/)
    expect(tool('report').description).toContain('The person sees it')
  })
})
