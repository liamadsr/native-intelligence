/**
 * The sandbox tokens (src/lib/cloud-browser/viewer-token.ts): Ed25519, the
 * sandbox holds only the public key, and a token opens one audience, one
 * sandbox, until it expires.
 */
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sandboxSigningKey, sandboxVerifyKey, signSandboxToken, verifySandboxToken } from '../viewer-token'

const { privateKey } = generateKeyPairSync('ed25519')
const verifyKey = sandboxVerifyKey(privateKey)
const claims = { aud: 'browser-viewer' as const, userId: 'u1', workspaceId: 'w1', sandbox: 'browser-a', control: true }

describe('sandbox tokens', () => {
  it('verify with the public key alone', () => {
    const token = signSandboxToken(claims, 60_000, privateKey)
    expect(verifySandboxToken(token, 'browser-viewer', 'browser-a', verifyKey)).toMatchObject(claims)
  })

  it('open only their own audience and sandbox, until they expire', () => {
    const token = signSandboxToken(claims, 60_000, privateKey)
    expect(verifySandboxToken(token, 'browser-exit', 'browser-a', verifyKey)).toBeNull()
    expect(verifySandboxToken(token, 'browser-viewer', 'browser-b', verifyKey)).toBeNull()
    expect(verifySandboxToken(token, 'browser-viewer', 'browser-a', verifyKey, Date.now() + 61_000)).toBeNull()
  })

  it('refuse another key, a tampered payload and garbage', () => {
    const other = sandboxVerifyKey(generateKeyPairSync('ed25519').privateKey)
    const token = signSandboxToken(claims, 60_000, privateKey)
    expect(verifySandboxToken(token, 'browser-viewer', 'browser-a', other)).toBeNull()
    const [, signature] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ ...claims, sandbox: 'browser-a', userId: 'someone', exp: Date.now() + 60_000 })).toString('base64url')
    expect(verifySandboxToken(`${forged}.${signature}`, 'browser-viewer', 'browser-a', verifyKey)).toBeNull()
    for (const junk of [null, '', 'x', 'a.b', 42]) expect(verifySandboxToken(junk, 'browser-viewer', 'browser-a', verifyKey)).toBeNull()
  })

  it('read the signing key from the environment, and only an Ed25519 one', () => {
    const der = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    expect(sandboxVerifyKey(sandboxSigningKey({ CLOUD_BROWSER_SIGNING_KEY: der })!)).toBe(verifyKey)
    expect(sandboxSigningKey({})).toBeNull()
    expect(sandboxSigningKey({ CLOUD_BROWSER_SIGNING_KEY: 'not a key' })).toBeNull()
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    expect(sandboxSigningKey({ CLOUD_BROWSER_SIGNING_KEY: rsa })).toBeNull()
  })
})
