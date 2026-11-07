/**
 * The part of git's smart-HTTP push protocol the push gate reads (pure, no I/O).
 *
 * A `git push` over HTTP is two requests:
 *   1. GET  <url>/info/refs?service=git-receive-pack  (the refs advertisement)
 *   2. POST <url>/git-receive-pack, whose body is pkt-lines:
 *        *( "shallow" SP <oid> )                          (from a shallow clone)
 *        <old-oid> SP <new-oid> SP <ref> NUL <capabilities>   (the first command)
 *        *( <old-oid> SP <new-oid> SP <ref> )               (more commands)
 *        flush-pkt ("0000")
 *        [ push options, flush-pkt ]  then the PACK data (absent for a delete).
 *
 * Every ref update the push makes is a command line before that first flush,
 * so reading them is enough to decide. The parse is deliberately STRICT, so it
 * can't disagree with whatever parses the same bytes on GitHub's side: only
 * well-formed data lines, ended by an exact "0000"; any other short packet
 * (0001-0004, which stock git also reads as an end), an empty line, a signed
 * push (push-cert), or a line that isn't a shallow or a command is refused.
 *
 * Git sends one other body: before a large push it probes with a lone flush
 * ("0000"). That changes nothing and gets an empty 200 (isProbe).
 */

/** One ref update. Object ids are lower-cased hex (SHA-1 or SHA-256). */
export interface ReceivePackCommand {
  oldOid: string
  newOid: string
  ref: string
}

export type ParsedReceivePack =
  | { ok: true; probe: true }
  | { ok: true; probe: false; commands: ReceivePackCommand[]; capabilities: string[] }
  | { ok: false; reason: string }

const OID = '(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})'
const COMMAND_RE = new RegExp(`^(${OID}) (${OID}) ([^\\s\\x00]+)$`)
const SHALLOW_RE = new RegExp(`^shallow ${OID}$`)
const ZERO_RE = /^0+$/

/** The empty-ref oid (all zeros): as the new value it means "delete". */
export function isZeroOid(oid: string): boolean {
  return ZERO_RE.test(oid)
}

const latin1 = new TextDecoder('latin1')

/** Parse the command section of a receive-pack request body. */
export function parseReceivePackRequest(body: Uint8Array): ParsedReceivePack {
  if (body.length === 4 && latin1.decode(body) === '0000') return { ok: true, probe: true }
  const commands: ReceivePackCommand[] = []
  let capabilities: string[] = []
  let pos = 0
  for (;;) {
    if (pos + 4 > body.length) return { ok: false, reason: 'the push ended before its command list did' }
    const lenHex = latin1.decode(body.subarray(pos, pos + 4))
    if (!/^[0-9a-f]{4}$/.test(lenHex)) return { ok: false, reason: 'the push is not in git protocol form' }
    const len = parseInt(lenHex, 16)
    if (len === 0) break
    // 0001-0004 (delim, response-end, invalid, empty) never belong in a command list.
    if (len <= 4) return { ok: false, reason: 'the push carries an unexpected special packet' }
    if (pos + len > body.length) return { ok: false, reason: 'the push ended inside a packet' }
    let line = latin1.decode(body.subarray(pos + 4, pos + len))
    pos += len
    if (line.endsWith('\n')) line = line.slice(0, -1)
    if (line.length === 0) return { ok: false, reason: 'the push carries an empty line' }
    if (line.startsWith('push-cert')) return { ok: false, reason: 'signed pushes are not supported' }
    const nul = line.indexOf('\0')
    const head = nul >= 0 ? line.slice(0, nul) : line
    if (nul >= 0) {
      if (commands.length > 0) return { ok: false, reason: 'capabilities may only follow the first command' }
      capabilities = line.slice(nul + 1).split(' ').filter(Boolean)
    }
    if (SHALLOW_RE.test(head) && nul < 0) continue
    const m = COMMAND_RE.exec(head)
    if (!m) return { ok: false, reason: 'the push carries a line that is not a ref update' }
    commands.push({ oldOid: m[1].toLowerCase(), newOid: m[2].toLowerCase(), ref: m[3] })
  }
  if (commands.length === 0) return { ok: false, reason: 'the push names no ref to update' }
  // Push options follow the command list in a section of their own: the gate
  // judges only the commands, so it never forwards a section it didn't read.
  if (capabilities.includes('push-options')) return { ok: false, reason: 'push options (git push -o) are not supported' }
  return { ok: true, probe: false, commands, capabilities }
}

/** Why one command may not go through, or null when it may. */
export function refusalFor(cmd: ReceivePackCommand, allowedBranch: string): string | null {
  const allowedRef = `refs/heads/${allowedBranch}`
  if (cmd.ref !== allowedRef) return `dial8: this run may only push its own branch ${allowedBranch}`
  if (isZeroOid(cmd.newOid)) return `dial8: this run may not delete ${allowedBranch}`
  return null
}

/**
 * Decide the whole push. One refused command refuses all of it (never a partial
 * push): each command gets its own reason, and an allowed one in a refused push
 * says why it didn't go either.
 */
export function judgeReceivePack(
  commands: ReceivePackCommand[],
  allowedBranch: string,
): { allowed: true } | { allowed: false; rejections: Array<{ ref: string; reason: string }> } {
  const reasons = commands.map((c) => refusalFor(c, allowedBranch))
  if (reasons.every((r) => r === null)) return { allowed: true }
  return {
    allowed: false,
    rejections: commands.map((c, i) => ({ ref: c.ref, reason: reasons[i] ?? 'dial8: not pushed, another ref in this push was refused' })),
  }
}

function pkt(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(data.length + 4)
  out.set(new TextEncoder().encode((data.length + 4).toString(16).padStart(4, '0')), 0)
  out.set(data, 4)
  return out
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const FLUSH = new TextEncoder().encode('0000')

/** Keep a reason on one line, short and ASCII. */
function cleanReason(reason: string): string {
  return reason.replace(/[^\x20-\x7e]/g, ' ').slice(0, 200)
}

/**
 * The report-status answer that refuses refs, so git prints
 * `! [remote rejected] <ref> (<reason>)` instead of a bare HTTP error. When the
 * client asked for side-band, the report travels in band 1 (as git's own
 * receive-pack sends it), after a band-2 line git prints as "remote: …".
 */
export function rejectionReport(
  rejections: Array<{ ref: string; reason: string }>,
  capabilities: string[],
): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder()
  const report = concat([
    pkt(enc.encode('unpack ok\n')),
    ...rejections.map((r) => pkt(enc.encode(`ng ${r.ref} ${cleanReason(r.reason)}\n`))),
    FLUSH,
  ])
  const sideband = capabilities.includes('side-band-64k') || capabilities.includes('side-band')
  if (!sideband) return report
  const max = capabilities.includes('side-band-64k') ? 65515 : 995
  const parts: Uint8Array[] = [
    pkt(concat([Uint8Array.of(2), enc.encode('dial8: a coding run can push only its own branch; nothing was pushed.\n')])),
  ]
  for (let i = 0; i < report.length; i += max) parts.push(pkt(concat([Uint8Array.of(1), report.subarray(i, i + max)])))
  parts.push(FLUSH)
  return concat(parts)
}

/** Whether the client asked for a status report it can read (else it gets a plain HTTP refusal). */
export function wantsReportStatus(capabilities: string[]): boolean {
  return capabilities.includes('report-status') || capabilities.includes('report-status-v2')
}
