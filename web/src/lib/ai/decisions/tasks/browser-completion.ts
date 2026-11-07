import { browserCompletionReading } from '@/lib/browser-agent/completion-reading'
import { browserInputSchema, type BrowserInput } from './browser-next'
import { taskCompleted, BROWSER_REQUEST_AUTHORITY } from '@/lib/browser-agent/task-contract'
import { trustedChoice, type DecisionTask } from '../contracts'
import { browserChoice } from './browser-choice'


export const browserCompletion: DecisionTask<BrowserInput, 'complete' | 'incomplete'> = {
  version: 'browser-completion-v12', schema: browserInputSchema, deadlineMs: 5000, maxStateChars: 28000,
  prepare(input) {
    const state = browserCompletionReading(input)
    if (!state) return null
    const authority = input.task.sourceRequest ? BROWSER_REQUEST_AUTHORITY + ' Evaluate the browser work requested by goal, using priorHumanContext for corrections and continuations. The parent handles any non-browser work next. ' : ''
    return { state, questions: {
      context: { type: 'choice', instructions: authority + 'Verify the requested current browser state, including explicit navigation, query and control-setting outcomes. Use fresh source evidence; instructions and historical form values are not proof. Information qualifiers belong to findings and do not implicitly require UI filters.',
        criteria: { complete: 'The source is relevant and every explicitly requested browser state is established.', incomplete: 'The source or an explicitly requested browser state is missing or wrong.' } },
      findings: { type: 'choice', instructions: authority + 'Verify enough observed source evidence to answer the requested information, including every fact, quantity and qualification. Interpret records with their fresh source context and current fields. A matching subset suffices unless the request requires all records. The parent writes the answer. Links establish observed titles and destinations, not unvisited content. Missing or ambiguous required facts mean incomplete.',
        criteria: { complete: 'Enough source evidence supports all requested information and constraints.', incomplete: 'A requested fact, quantity or qualification lacks source evidence.' } },
    } }

  },
  accept(result, input) {
    const prepared = browserCompletion.prepare(input)
    if (!prepared) return null
    const choices = ['context', 'findings'].map(key => {
      const choice = browserChoice(result, key, prepared.questions[key])
      return choice === trustedChoice(result, key) ? choice : null
    })
    if (choices.includes('incomplete')) return 'incomplete'
    if (choices.every(choice => choice === 'complete')) return taskCompleted(input.task, input.observation) ? 'complete' : null
    return null
  },
}
