/**
 * The reply code the channels show for an approval ("yes K7Q4MX"), keyed with
 * a server secret: the approval's id reaches the model (the tool result of a
 * held call), so a code that is a plain hash of the id would fall to anyone
 * the id leaks to. HMAC-SHA256 of the id under a key derived from
 * RUN_SKILL_INTERNAL_SECRET (required in every deployment; a fixed dev key
 * outside production), six characters of caller.ts CODE_ALPHABET, never a
 * word a reply reads as a plain yes or no. Stable: the same approval always
 * shows the same code. Server only. Never logs the key.
 */
import { createHmac } from 'node:crypto'
import { CODE_ALPHABET, REPLY_CODE_LENGTH, isYesOrNoWord } from './caller'
import { ROOT_INTERNAL_SECRET_ENV } from '@/lib/eve/internal-secret'

let cachedKey: { root: string; key: string } | null = null

function codeKey(): string {
  const root = process.env[ROOT_INTERNAL_SECRET_ENV] || ''
  if (!root && process.env.NODE_ENV === 'production') throw new Error('reply codes need RUN_SKILL_INTERNAL_SECRET')
  if (!cachedKey || cachedKey.root !== root) {
    cachedKey = { root, key: createHmac('sha256', root || 'dial8-dev-only').update('dial8:approval-reply-code:v1').digest('hex') }
  }
  return cachedKey.key
}

export function serverReplyCode(approvalId: string): string {
  for (let salt = 0; ; salt++) {
    const digest = createHmac('sha256', codeKey()).update(salt ? `${approvalId}#${salt}` : approvalId).digest()
    let code = ''
    for (let i = 0; i < REPLY_CODE_LENGTH; i++) code += CODE_ALPHABET[digest[i] % CODE_ALPHABET.length]
    if (!isYesOrNoWord(code)) return code
  }
}
