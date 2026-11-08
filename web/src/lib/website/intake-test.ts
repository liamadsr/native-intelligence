/**
 * The website flow's live check, the intake's side (roadmap track E): the
 * test post's fields and its one-time nonce. Light on purpose: the public
 * intake route imports it (src/app/api/intake/quotes/[key]/route.ts), so it
 * reaches only the change store.
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getChangeByNonce, updateChange } from './store'
import { INTAKE_TEST_FIELD } from './types'

type Svc = SupabaseClient

/** The test post's fields: a person's, so the intake parses it as a form, plus the nonce. Pure. */
export function testSubmission(nonce: string): Record<string, string> {
  return {
    name: 'Native Intelligence website check',
    email: 'website-check@dial8.ai',
    message: 'A test from Native Intelligence to check this website form reaches the business. Not a customer: please ignore.',
    [INTAKE_TEST_FIELD]: nonce,
  }
}

export function nonceHash(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex')
}

/**
 * The intake's side of the check (intake-handler.ts takeTest): a post whose
 * test field's nonce hashes to one of this workspace's checks is that check,
 * recorded once while its change deploys. False for anything else (it goes
 * on as an ordinary post).
 */
export async function takeIntakeTest(svc: Svc, workspaceId: string, nonce: string, nowMs: number = Date.now()): Promise<boolean> {
  if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 64) return false
  const change = await getChangeByNonce(svc, workspaceId, nonceHash(nonce))
  if (!change) return false
  // Ours either way: a replayed or late nonce is never stored as a quote, only the first, while deploying, is recorded.
  if (change.state === 'deploying' && !change.checkResult?.receivedAt) {
    await updateChange(svc, workspaceId, change.id, { check_result: { outcome: 'passed', receivedAt: new Date(nowMs).toISOString() } }, ['deploying'])
  }
  return true
}
