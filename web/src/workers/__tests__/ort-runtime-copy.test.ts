/**
 * scripts/copy-ort-runtime.mjs SERVES THE WORKER'S EXACT ONNX RUNTIME.
 *
 * The voice-embedding worker imports ONNX Runtime's wasm glue from
 * /ort/<version>/ (public/ort, copied before next dev and next build).
 * Pinned here, against the installed packages: the copy is the onnxruntime-web
 * version transformers.js pins, its files are byte-for-byte the ones that
 * version's browser entry loads, and a run leaves no other version behind.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ORT_DIR = join(process.cwd(), 'node_modules/onnxruntime-web')
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path, 'latin1'), 'latin1').digest('hex')

let out: string

beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'ort-runtime-'))
})

afterEach(() => {
  rmSync(out, { recursive: true, force: true })
})

describe('copy-ort-runtime', () => {
  it("copies the pinned onnxruntime-web's runtime files under its version, and nothing else", () => {
    mkdirSync(join(out, '0.0.1'))
    writeFileSync(join(out, '0.0.1', 'ort-wasm-simd-threaded.jsep.mjs'), 'stale')

    execFileSync(process.execPath, ['scripts/copy-ort-runtime.mjs', out], { stdio: 'pipe' })

    const { version } = readJson(join(ORT_DIR, 'package.json'))
    const pinned = readJson(join(process.cwd(), 'node_modules/@huggingface/transformers/package.json')).dependencies['onnxruntime-web']
    expect(version).toBe(pinned)
    expect(readdirSync(out)).toEqual([version])

    const files = readdirSync(join(out, version)).sort()
    expect(files).toEqual(['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'])
    for (const file of files) {
      expect(sha256(join(out, version, file)), file).toBe(sha256(join(ORT_DIR, 'dist', file)))
    }
  })
})
