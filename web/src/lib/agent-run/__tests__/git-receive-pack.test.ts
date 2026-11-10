/**
 * The push gate's reading of git's receive-pack request: strict, so whatever
 * reads the same bytes on GitHub's side can't see a ref update it didn't.
 */
import { describe, expect, it } from 'vitest'
import { judgeReceivePack, parseReceivePackRequest, rejectionReport, wantsReportStatus } from '../git-receive-pack'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const Z = '0'.repeat(40)
const BRANCH = 'dial8/web-12-abcd1234'

const enc = new TextEncoder()
function pkt(s: string): string {
  return (Buffer.byteLength(s) + 4).toString(16).padStart(4, '0') + s
}
function body(...lines: string[]): Uint8Array {
  return enc.encode(lines.join('') + '0000' + 'PACK\0\0\0\x02junk')
}
const CAPS = '\0report-status side-band-64k agent=git/2.45.0'

describe('parseReceivePackRequest', () => {
  it('reads the commands, capabilities and skips shallow lines', () => {
    const r = parseReceivePackRequest(body(pkt(`shallow ${A}\n`), pkt(`${A} ${B} refs/heads/${BRANCH}${CAPS}\n`)))
    expect(r).toEqual({
      ok: true,
      probe: false,
      commands: [{ oldOid: A, newOid: B, ref: `refs/heads/${BRANCH}` }],
      capabilities: ['report-status', 'side-band-64k', 'agent=git/2.45.0'],
    })
  })

  it('reads every command before the flush (a second ref can not hide)', () => {
    const r = parseReceivePackRequest(body(pkt(`${A} ${B} refs/heads/${BRANCH}${CAPS}\n`), pkt(`${Z} ${B} refs/heads/main\n`)))
    expect(r.ok && !r.probe && r.commands.map((c) => c.ref)).toEqual([`refs/heads/${BRANCH}`, 'refs/heads/main'])
  })

  it('treats a lone flush as git\'s auth probe', () => {
    expect(parseReceivePackRequest(enc.encode('0000'))).toEqual({ ok: true, probe: true })
  })

  it.each([
    ['an empty body', enc.encode('')],
    ['no flush', enc.encode(pkt(`${A} ${B} refs/heads/${BRANCH}${CAPS}\n`))],
    ['a delim packet hiding a second list', enc.encode(pkt(`${A} ${B} refs/heads/${BRANCH}${CAPS}\n`) + '0001' + pkt(`${A} ${B} refs/heads/main\n`) + '0000')],
    ['an empty 0004 packet', enc.encode(pkt(`${A} ${B} refs/heads/${BRANCH}${CAPS}\n`) + '0004' + pkt(`${A} ${B} refs/heads/main\n`) + '0000')],
    ['an empty line', enc.encode(pkt(`${A} ${B} refs/heads/${BRANCH}${CAPS}\n`) + pkt('\n') + pkt(`${A} ${B} refs/heads/main\n`) + '0000')],
    ['a signed push', body(pkt(`push-cert${CAPS}\n`))],
    ['a non-hex length', enc.encode('zzzz')],
    ['a short oid', body(pkt(`${A.slice(1)} ${B} refs/heads/${BRANCH}${CAPS}\n`))],
    ['a ref with a space', body(pkt(`${A} ${B} refs/heads/${BRANCH} x${CAPS}\n`))],
    ['a stray line', body(pkt(`hello${CAPS}\n`))],
    ['capabilities on a later line', body(pkt(`${A} ${B} refs/heads/${BRANCH}${CAPS}\n`), pkt(`${A} ${B} refs/heads/x${CAPS}\n`))],
    ['only shallow lines', body(pkt(`shallow ${A}\n`))],
    ['push options (a section the gate would forward unread)', body(pkt(`${A} ${B} refs/heads/${BRANCH}\0report-status push-options\n`))],
    ['a packet longer than the body', enc.encode('00ff' + 'x')],
  ])('refuses %s', (_label, b) => {
    const r = parseReceivePackRequest(b)
    expect(r.ok).toBe(false)
  })
})

describe('judgeReceivePack', () => {
  const cmd = (ref: string, newOid = B, oldOid = A) => ({ oldOid, newOid, ref })

  it("accepts the run's own branch, new or updated", () => {
    expect(judgeReceivePack([cmd(`refs/heads/${BRANCH}`)], BRANCH)).toEqual({ allowed: true })
    expect(judgeReceivePack([cmd(`refs/heads/${BRANCH}`, B, Z)], BRANCH)).toEqual({ allowed: true })
  })

  it.each([
    'refs/heads/main',
    'refs/heads/master',
    'refs/heads/gh-pages',
    'refs/heads/dial8/web-13-ffff0000',
    `refs/heads/${BRANCH}-x`,
    `refs/tags/${BRANCH}`,
    `refs/heads/${BRANCH.toUpperCase()}`,
    'HEAD',
    'refs/pull/1/head',
  ])('refuses %s', (ref) => {
    const v = judgeReceivePack([cmd(ref)], BRANCH)
    expect(v.allowed).toBe(false)
  })

  it('refuses deleting its own branch', () => {
    const v = judgeReceivePack([cmd(`refs/heads/${BRANCH}`, Z)], BRANCH)
    expect(v).toEqual({ allowed: false, rejections: [{ ref: `refs/heads/${BRANCH}`, reason: `Native Intelligence: this run may not delete ${BRANCH}` }] })
  })

  it('refuses the whole push when one ref is wrong, never a partial push', () => {
    const v = judgeReceivePack([cmd(`refs/heads/${BRANCH}`), cmd('refs/heads/main')], BRANCH)
    expect(v.allowed).toBe(false)
    if (!v.allowed) {
      expect(v.rejections).toHaveLength(2)
      expect(v.rejections[0].reason).toMatch(/another ref in this push was refused/)
      expect(v.rejections[1].reason).toMatch(/may only push its own branch/)
    }
  })
})

describe('rejectionReport', () => {
  const rejections = [{ ref: 'refs/heads/main', reason: 'Native Intelligence: this run may only push its own branch x' }]

  it('without side-band: plain report-status pkt-lines', () => {
    const out = Buffer.from(rejectionReport(rejections, ['report-status'])).toString('latin1')
    expect(out).toBe(pkt('unpack ok\n') + pkt('ng refs/heads/main Native Intelligence: this run may only push its own branch x\n') + '0000')
  })

  it('with side-band-64k: a band-2 note, then the report in band 1, then a flush', () => {
    const out = Buffer.from(rejectionReport(rejections, ['report-status', 'side-band-64k'])).toString('latin1')
    const inner = pkt('unpack ok\n') + pkt('ng refs/heads/main Native Intelligence: this run may only push its own branch x\n') + '0000'
    expect(out.endsWith(pkt('\x01' + inner) + '0000')).toBe(true)
    expect(out.slice(4, 5)).toBe('\x02')
  })

  it('knows when the client can read a report', () => {
    expect(wantsReportStatus(['report-status'])).toBe(true)
    expect(wantsReportStatus(['report-status-v2'])).toBe(true)
    expect(wantsReportStatus(['side-band-64k'])).toBe(false)
  })
})
