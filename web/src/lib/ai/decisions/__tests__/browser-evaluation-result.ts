import { browserNext, type BrowserInput } from '../tasks/browser-next'
import type { Evaluation } from '../contracts'

/** Realistic complete distributions for the exact dynamically offered questions. */
export function browserEvaluation(input: BrowserInput, selections: Record<string, {
  choice: string; probability?: number; confidence?: number
}> = {}): Evaluation {
  const prepared = browserNext.prepare(input)
  if (!prepared) throw new Error('Fixture does not prepare browser questions')
  const confidence: Record<string, number> = {}
  const answers = Object.fromEntries(Object.entries(prepared.questions).map(([key, question]) => {
    if (question.type !== 'choice') throw new Error('Expected browser choice question')
    const keys = Object.keys(question.criteria)
    const selection = selections[key]
    const choice = selection?.choice ?? (key === 'completion' ? 'incomplete' : key === 'operation' || key === 'action' ? 'escalate' : 'none')
    const p = keys.length === 1 ? 1 : selection?.probability ?? .99
    confidence[key] = selection?.confidence ?? .99
    const probabilities = Object.fromEntries(keys.map(option => [option, option === choice ? p : (1 - p) / (keys.length - 1)]))
    if (!keys.includes(choice)) probabilities[choice] = p // Deliberately forged fixtures remain malformed.
    return [key, { type: 'choice', choice, probabilities }]
  }))
  return { answers, providerMetadata: { typesafe: { confidence } } } as unknown as Evaluation
}
