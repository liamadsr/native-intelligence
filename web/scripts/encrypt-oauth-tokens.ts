/**
 * One-off back-fill (security review 2026-10-31): encrypt the provider OAuth
 * tokens still stored in plaintext in user_oauth_tokens. The work, and why it
 * is safe to re-run, is src/lib/oauth/token-backfill.ts: only plaintext columns
 * are rewritten, each write fenced on what it read; Jira and Linear rows with
 * an expiry are left to migrate at their own next refresh; and nothing is
 * written until the key is proven to be the app's (it must open the app's own
 * ciphertexts in connected_mcp_server, and fail on none).
 *
 * DRY-RUN by default: prints counts, writes nothing. Pass --execute to write.
 * It prints counts only, never an id, an email or a token.
 *
 * Usage:
 *   npx tsx scripts/encrypt-oauth-tokens.ts [--execute] [--env-file <path>]
 *
 * Required env vars:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   — the anon key silently reads/writes 0 rows under RLS.
 *   CREDENTIAL_ENCRYPTION_KEY   — --execute only (a dry run with it also runs
 *                                 the key check). It must be the key the app
 *                                 runs with in that environment.
 * Read from --env-file when given, and then the file WINS over anything already
 * exported in the shell, but only for what the file holds. With no --env-file,
 * .env.local fills only what isn't exported. The script prints its target host
 * first: check it before --execute. It never prints a key.
 *
 * WHERE THE KEY COMES FROM. For DEV, .env.local holds it. For PROD it is a
 * Sensitive Vercel variable: no .env.*.local file holds it (not
 * .env.production.local either), and neither `vercel env pull` nor the Vercel
 * dashboard will give it back. The only copies are the deployment's and
 * whatever was saved when it was generated. With a saved copy, export it for
 * the one command without echoing it or leaving it in shell history (the env
 * file does not hold it, so the exported value stands):
 *   read -rs CREDENTIAL_ENCRYPTION_KEY && export CREDENTIAL_ENCRYPTION_KEY
 *   npx tsx scripts/encrypt-oauth-tokens.ts --env-file <main checkout>/.env.production.local
 *   npx tsx scripts/encrypt-oauth-tokens.ts --env-file <main checkout>/.env.production.local --execute
 *   unset CREDENTIAL_ENCRYPTION_KEY
 * With no saved copy, run encryptPlaintextOAuthTokens inside the deployment
 * instead (a one-off Inngest function), which uses the deployment's own key.
 *
 * PROD only with Liam's word, and only after the code that decrypts is deployed:
 * before that, the live code would send ciphertext to the providers.
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { TokenBackfillRefused, encryptPlaintextOAuthTokens } from '../src/lib/oauth/token-backfill'

const arg = (flag: string) => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? (process.argv[at + 1] ?? null) : null
}

const ENV_FILE = arg('--env-file')
config({ path: ENV_FILE ?? '.env.local', override: ENV_FILE !== null, quiet: true })

const EXECUTE = process.argv.includes('--execute')

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL')
if (!SUPABASE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

async function main() {
  console.log(`Target: ${new URL(SUPABASE_URL!).host}`)
  console.log(EXECUTE ? 'Mode: EXECUTE' : 'Mode: DRY RUN (pass --execute to write)')

  const c = await encryptPlaintextOAuthTokens(supabase, { execute: EXECUTE })
  console.log(`rows:                          ${c.rows}`)
  console.log(`access_token  plaintext:       ${c.accessPlaintext}`)
  console.log(`access_token  encrypted:       ${c.accessEncrypted}`)
  console.log(`refresh_token plaintext:       ${c.refreshPlaintext}`)
  console.log(`refresh_token encrypted:       ${c.refreshEncrypted}`)
  console.log(`refresh_token null:            ${c.refreshNull}`)
  console.log(`jira/linear left to refresh:   ${c.rotatingLeft}`)
  console.log(`rows to encrypt:               ${c.toEncrypt}`)
  if (c.keyOpened === null) console.log('key check:                     skipped (no CREDENTIAL_ENCRYPTION_KEY)')
  else console.log(`key check:                     ${c.keyOpened} app ciphertexts open, ${c.keyFailed} don't`)
  if (!EXECUTE) return
  console.log(`encrypted:                     ${c.encrypted}`)
  console.log(`changed since read (skipped):  ${c.changedSinceRead}`)
  console.log(`failed:                        ${c.failed}`)
  if (c.failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err instanceof TokenBackfillRefused ? `REFUSED: ${err.message}` : err instanceof Error ? err.message : String(err))
  process.exit(1)
})
