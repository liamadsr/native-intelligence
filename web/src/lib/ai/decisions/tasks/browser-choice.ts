import { probability, type Evaluation, type Questions } from '../contracts'

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Browser action selection follows a valid offered argmax, not a certainty threshold.
 * Keep this separate from the stricter shared policy used for terminal decisions.
 * The SDK validates live responses too; this guard also protects direct acceptance
 * and rejects a distribution for a different observed candidate set.
 */
export function browserChoice(result: Evaluation, key: string, question: Questions[string] | undefined): string | null {
  if (question?.type !== 'choice') return null
  const answer = result.answers?.[key]
  const confidence = (result.providerMetadata?.typesafe?.confidence as Record<string, unknown> | undefined)?.[key]
  if (answer?.type !== 'choice' || !Object.hasOwn(question.criteria, answer.choice) || !probability(confidence)) return null
  const distribution = answer.probabilities
  const keys = Object.keys(question.criteria)
  if (!record(distribution) || Object.keys(distribution).length !== keys.length ||
      !keys.every(option => Object.hasOwn(distribution, option)) || !Object.values(distribution).every(probability)) return null
  const rounding = result.rounding
  if (rounding !== undefined && !record(rounding)) return null
  const decimals = rounding?.probabilityDecimals
  if (decimals !== undefined && (!Number.isInteger(decimals) || decimals < 0 || decimals > 15)) return null
  // Honor the provider's declared precision, with a bounded cumulative error.
  // A hundred two-decimal choices must not excuse half the probability mass.
  const tolerance = 1e-6 + (decimals === undefined ? 0 : Math.min(0.02, keys.length * 0.5 * 10 ** -decimals))
  const values = Object.values(distribution) as number[]
  if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > tolerance ||
      values.some(value => value > distribution[answer.choice]! + 1e-6)) return null
  return answer.choice
}
