// Seals production's write-only settings to the server's public key, for the move
// off this host (deploy/README.md step 21, Gate 1; deploy/app/README.md, "Sealed
// copy"). The LAST step of `npm run build` (the host keeps only the end of a build
// log once it passes 4 MB, and the test suite alone fills that), and inert unless
// BOTH are true:
//
//   NI_SEAL_SETTINGS=1   set for this one build, by hand, then removed
//   VERCEL_ENV=production and VERCEL_TARGET_ENV is production or unset
//
// Then it reads the settings named in NAMES from this build's environment, exactly
// as stored (a trailing line break kept), and prints ONE block to the build log:
// those names and values encrypted to the key in seal-settings.pub (X25519, HKDF-
// SHA256, AES-256-GCM, Node's own crypto). Only the server, which holds the private
// half, can open it. Nothing else is printed but names: never a value. A name the
// build does not have is listed by name.
//
// The public key is committed: a change to it shows in review. Once the copy is
// done the server deletes its private half, and every block printed since is noise.
import { createCipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * What the server needs and cannot read back from this host: its write-only
 * production settings. Not AI_GATEWAY_API_KEY (the server has a key of its own,
 * revocable on its own) nor the Inngest keys (the server's Inngest's own).
 * deploy/app/sealed_settings.py keeps the same list; a test holds them equal.
 */
export const NAMES = [
  'ADMIN_EMAILS',
  'AGENT_RUN_INTERNAL_SECRET',
  'ASANA_CLIENT_ID',
  'ASANA_CLIENT_SECRET',
  'BROWSER_INTERNAL_SECRET',
  'CHAT_INTERNAL_SECRET',
  'CLOUD_BROWSER_BASE_SNAPSHOT_ID',
  'CLOUD_BROWSER_SIGNING_KEY',
  'CREDENTIAL_ENCRYPTION_KEY',
  'DEEPGRAM_API_KEY',
  'EMAIL_FROM',
  'GATEWAY_USAGE_REPORTING',
  'GATEWAY_USER_TAGGING',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_WEBHOOK_SECRET',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GPT_LIVE_API_KEY',
  'GPT_LIVE_TRUNK_SECRET',
  'GPT_LIVE_WEBHOOK_SECRET',
  'HUBSPOT_CLIENT_ID',
  'HUBSPOT_CLIENT_SECRET',
  'JIRA_CLIENT_ID',
  'JIRA_CLIENT_SECRET',
  'LINEAR_CLIENT_SECRET',
  'LINEAR_WEBHOOK_SECRET',
  'LOCAL_AGENT_TOKEN_SECRET',
  'RUN_SKILL_INTERNAL_SECRET',
  'SENTRY_ORG',
  'SENTRY_PROJECT',
  'SLACK_SIGNING_SECRET',
  'STRIPE_SECRET_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
]

export const BEGIN = '-----BEGIN NI SEALED SETTINGS-----'
export const END = '-----END NI SEALED SETTINGS-----'
const INFO = 'ni-sealed-settings-v1'

const raw = (key) => key.export({ format: 'der', type: 'spki' }).subarray(-32)

/** The block for `values` ({ name: value }), sealed to `recipientSpki` (base64 SPKI DER of an X25519 key). */
export function sealBlock(values, recipientSpki, meta = {}) {
  const recipient = createPublicKey({ key: Buffer.from(recipientSpki.trim(), 'base64'), format: 'der', type: 'spki' })
  if (recipient.asymmetricKeyType !== 'x25519') throw new Error('seal-settings: the public key is not an X25519 key')
  const ephemeral = generateKeyPairSync('x25519')
  const epk = raw(ephemeral.publicKey)
  const rpk = raw(recipient)
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient })
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epk, rpk]), INFO, 32))
  const kid = createHash('sha256').update(rpk).digest('hex').slice(0, 16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`${INFO}:${kid}`))
  const ct = Buffer.concat([cipher.update(JSON.stringify({ ...meta, values }), 'utf8'), cipher.final()])
  const envelope = { v: 1, kid, epk: epk.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
  const body = Buffer.from(JSON.stringify(envelope)).toString('base64').match(/.{1,76}/g)
  return { kid, block: [BEGIN, ...body, END].join('\n') }
}

/** The settings of NAMES this environment has, as stored, and the names it lacks. */
export function collect(env) {
  const values = {}
  const missing = []
  for (const name of NAMES) {
    const value = env[name]
    if (typeof value === 'string' && value !== '') values[name] = value
    else missing.push(name)
  }
  return { values, missing }
}

/** What to do in this environment: 'off', 'not-production' or 'seal'. */
export function decide(env) {
  if (env.NI_SEAL_SETTINGS !== '1') return 'off'
  if (env.VERCEL_ENV !== 'production') return 'not-production'
  if (env.VERCEL_TARGET_ENV && env.VERCEL_TARGET_ENV !== 'production') return 'not-production'
  return 'seal'
}

export function main(env = process.env, out = (line) => process.stdout.write(`${line}\n`)) {
  const what = decide(env)
  if (what === 'off') return 0
  if (what === 'not-production') {
    out('seal-settings: NI_SEAL_SETTINGS is set, but this is not a production build: nothing sealed.')
    return 0
  }
  if (!env.VERCEL_DEPLOYMENT_ID) {
    // The server accepts a block only for the deployment it names.
    out('seal-settings: this build has no deployment id: nothing sealed.')
    return 0
  }
  const publicKey = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'seal-settings.pub'), 'utf8')
  const { values, missing } = collect(env)
  const meta = { sealedAt: new Date().toISOString(), commit: env.VERCEL_GIT_COMMIT_SHA ?? null, deployment: env.VERCEL_DEPLOYMENT_ID, env: 'production' }
  const { kid, block } = sealBlock(values, publicKey, meta)
  out(`seal-settings: ${Object.keys(values).length} of ${NAMES.length} settings sealed to the server's key ${kid}; no value is shown.`)
  out(block)
  if (missing.length) out(`seal-settings: not in this build: ${missing.join(', ')}`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main()
}
