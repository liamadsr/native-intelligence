/**
 * One Studio product job on the Mac (the Mac-only tool studio_product, ../tools/studio_product.ts): read the job from
 * the app, unpack the runner into the job's scratch dir, run it as ONE command inside the job's fence, and send what it
 * made back to the app (a report, or the capture's file). Nothing here runs the product's code itself: the runner does,
 * in the fence. The sandbox and the app are passed in, so the whole flow is tested with fakes.
 */

/** The parts of the job's sandbox this uses (eve's sandbox handle, bound to the job's fence). */
export type JobSandbox = {
  run(opts: { command: string; env?: Record<string, string>; abortSignal?: AbortSignal }): Promise<{ exitCode: number; stdout: string; stderr: string }>
  writeBinaryFile(opts: { path: string; content: Uint8Array; abortSignal?: AbortSignal }): Promise<void>
  writeTextFile(opts: { path: string; content: string; abortSignal?: AbortSignal }): Promise<void>
  readTextFile(opts: { path: string; abortSignal?: AbortSignal }): Promise<string | null>
  readBinaryFile(opts: { path: string; abortSignal?: AbortSignal }): Promise<Uint8Array | null>
}

/** A job as the app hands it to the Mac (GET /api/local-agent/agent/studio?job=). */
export type MacJob = {
  job: {
    id: string
    kind: 'onboard' | 'list' | 'capture' | 'refresh'
    title: string | null
    capture: { component: string; options: Record<string, unknown> } | null
    refresh: { items: { component: string; options: Record<string, unknown>; key: string }[] } | null
  }
  kit: Record<string, unknown> | null
}

/** The app, as this job reaches it (the session token is the client's business). */
export type JobApp = {
  getJob(id: string): Promise<MacJob>
  report(body: Record<string, unknown>): Promise<{ status?: string; error?: string; result?: unknown }>
  upload(meta: Record<string, unknown>, bytes: Uint8Array, contentType: string): Promise<{ assetId?: string; layerId?: string; refreshed?: string; importing?: string }>
}

/** The runner archive (build.sh's studio.tgz) and the environment its command gets. */
export type JobDeps = { sandbox: JobSandbox; app: JobApp; archive: () => Promise<Uint8Array>; env?: Record<string, string>; signal?: AbortSignal }

/** Where the runner lives in the job's scratch dir (the sandbox maps /workspace/.eve there, even in a read-only job). */
export const STUDIO_DIR = '/workspace/.eve/studio'

/** A command-line word, single-quoted for bash. */
export function shellWord(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/** The runner's answer: what it printed as its one JSON line, or a failure naming what it wrote to stderr. */
export function runnerAnswer(res: { exitCode: number; stdout: string; stderr: string }): Record<string, unknown> & { ok: boolean } {
  const line = res.stdout.trim().split('\n').filter(Boolean).at(-1) ?? ''
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>
    if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean') return parsed as Record<string, unknown> & { ok: boolean }
  } catch {
    // Not JSON: the runner did not get as far as answering.
  }
  const why = res.stderr.trim().split('\n').filter(Boolean).at(-1) ?? `exit ${res.exitCode}`
  return { ok: false, error: `The runner stopped: ${why.slice(0, 300)}` }
}

/** The file name a runner path ends in (the runner answers host paths; the sandbox reads /workspace paths). */
export const baseName = (path: unknown) => String(path ?? '').split('/').pop() ?? ''

/** Unpack the runner into the scratch dir (once per archive: a marker names the archive it came from). */
export async function stageRunner(deps: JobDeps): Promise<void> {
  const archive = await deps.archive()
  const tag = await sha256Hex(archive)
  const marker = await deps.sandbox.readTextFile({ path: `${STUDIO_DIR}/runner.tag`, abortSignal: deps.signal }).catch(() => null)
  if (marker?.trim() === tag) return
  await deps.sandbox.writeBinaryFile({ path: `${STUDIO_DIR}/studio.tgz`, content: archive, abortSignal: deps.signal })
  const res = await deps.sandbox.run({ command: `cd ${STUDIO_DIR} && rm -rf runner && tar -xzf studio.tgz && rm -f studio.tgz`, abortSignal: deps.signal })
  if (res.exitCode !== 0) throw new Error(`Could not unpack the Studio runner: ${res.stderr.trim().slice(0, 300)}`)
  await deps.sandbox.writeTextFile({ path: `${STUDIO_DIR}/runner.tag`, content: tag, abortSignal: deps.signal })
}

/** SHA-256 hex of bytes (Web Crypto, as the eve server's Node has it). */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The command line for the runner: run in the product's folder (/workspace) with the product's node_modules on
 * NODE_PATH, so the runner's own `import('esbuild')` loads the product's esbuild (the runner never ships one).
 */
export function runnerCommand(args: string[]): string {
  return `NODE_PATH=/workspace/node_modules node ${args.map(shellWord).join(' ')}`
}

/** Run one runner command in the fence; `request` is written beside its output first. Answers its JSON. */
export async function runRunner(deps: JobDeps, dir: string, command: 'onboard' | 'list' | 'capture', request?: unknown) {
  const out = `${dir}/out-${command}`
  const args = [`${STUDIO_DIR}/runner/runner.cjs`, command]
  if (request !== undefined) {
    await deps.sandbox.writeTextFile({ path: `${dir}/${command}.json`, content: JSON.stringify(request), abortSignal: deps.signal })
    args.push(`${dir}/${command}.json`)
  }
  args.push(out)
  const res = await deps.sandbox.run({ command: runnerCommand(args), ...(deps.env ? { env: deps.env } : {}), abortSignal: deps.signal })
  return { answer: runnerAnswer(res), out }
}

/** Send a capture's file to the app with what it is. */
async function sendCapture(deps: JobDeps, jobId: string, component: string, answer: Record<string, unknown>, out: string, item?: number) {
  const path = `${out}/${baseName(answer.file)}`
  const bytes = await deps.sandbox.readBinaryFile({ path, abortSignal: deps.signal })
  if (!bytes) throw new Error('The capture finished but its file is missing.')
  const kind = answer.kind === 'video' ? 'video' : 'still'
  const meta = {
    job: jobId,
    ...(item === undefined ? {} : { item }),
    component,
    name: String(answer.name ?? component).slice(0, 250),
    kind,
    width: Number(answer.width),
    height: Number(answer.height),
    aspect: Number(answer.aspect),
    seconds: Number(answer.seconds ?? 0),
    key: String(answer.key ?? ''),
    commit: typeof answer.commit === 'string' ? answer.commit : null,
  }
  return deps.app.upload(meta, bytes, kind === 'video' ? 'video/webm' : 'image/png')
}

/** The components a listing answered, as the app's report takes them. */
const listedComponents = (answer: Record<string, unknown>) => (Array.isArray(answer.components) ? answer.components : [])

/** Run the job and answer one or two sentences for the model. Failures are reported to the app, then answered too. */
export async function runStudioJob(jobId: string, deps: JobDeps): Promise<string> {
  const { job, kit } = await deps.app.getJob(jobId)
  // Only the job asked for: its id names the scratch folder and every report, so another one is never run or answered.
  if (job?.id !== jobId) return 'The Studio job could not run: the app answered with another job than the one asked for. Nothing was run.'
  await stageRunner(deps)
  const dir = `${STUDIO_DIR}/jobs/${job.id}`
  const fail = async (error: string) => {
    await deps.app.report({ job: job.id, ok: false, error: error.slice(0, 500) }).catch(() => null)
    return `The Studio job failed: ${error}`
  }
  if (job.kind === 'onboard') {
    const { answer } = await runRunner(deps, dir, 'onboard')
    if (!answer.ok) return fail(String(answer.error))
    const listed = await runRunner(deps, dir, 'list', { kit: answer.kit })
    const components = listed.answer.ok ? listedComponents(listed.answer) : []
    const saved = await deps.app.report({ job: job.id, ok: true, kit: answer.kit, notes: answer.notes ?? [], components, commit: answer.commit ?? null, ...(listed.answer.ok ? (listed.answer.note ? { note: listed.answer.note } : {}) : { note: String(listed.answer.error) }) })
    const renders = components.filter((c) => (c as { status?: string }).status === 'ok').length
    return saved.error ? `The Studio refused the product: ${saved.error}` : `The product is set up in the Studio: ${components.length} components listed, ${renders} render on their own.`
  }
  if (!kit) return fail('The product has no settings yet: onboard it first.')
  if (job.kind === 'list') {
    const { answer } = await runRunner(deps, dir, 'list', { kit })
    if (!answer.ok) return fail(String(answer.error))
    await deps.app.report({ job: job.id, ok: true, components: listedComponents(answer), commit: answer.commit ?? null, ...(answer.note ? { note: answer.note } : {}) })
    return `Listed ${listedComponents(answer).length} components in the Studio.`
  }
  if (job.kind === 'capture' && job.capture) {
    const { answer, out } = await runRunner(deps, dir, 'capture', { kit, component: job.capture.component, options: job.capture.options })
    if (!answer.ok) return fail(String(answer.error))
    const sent = await sendCapture(deps, job.id, job.capture.component, answer, out)
    if (sent.importing) return 'The capture reached the Studio and is still importing.'
    return `The capture is in the Studio library${sent.layerId ? ' and on the video' : ''}.${answer.note ? ` ${String(answer.note)}` : ''}`
  }
  if (job.kind === 'refresh' && job.refresh) {
    const { answer } = await runRunner(deps, dir, 'list', { kit })
    if (!answer.ok) return fail(String(answer.error))
    const keys = new Map(listedComponents(answer).map((c) => [String((c as { id: string }).id), String((c as { key: string }).key)]))
    const items: { item: number; outcome: string }[] = []
    for (const [index, item] of job.refresh.items.entries()) {
      const now = keys.get(item.component)
      if (now === undefined) items.push({ item: index, outcome: 'the product no longer has this component' })
      else if (now === item.key) items.push({ item: index, outcome: 'current' })
      else {
        const shot = await runRunner(deps, `${dir}/item-${index}`, 'capture', { kit, component: item.component, options: item.options })
        if (!shot.answer.ok) items.push({ item: index, outcome: String(shot.answer.error).slice(0, 300) })
        else {
          await sendCapture(deps, job.id, item.component, shot.answer, shot.out, index)
          items.push({ item: index, outcome: 'captured' })
        }
      }
    }
    await deps.app.report({ job: job.id, ok: true, components: listedComponents(answer), commit: answer.commit ?? null, items })
    const captured = items.filter((i) => i.outcome === 'captured').length
    return `${captured} of ${items.length} component layers were made again from the current code; ${items.filter((i) => i.outcome === 'current').length} were already current.`
  }
  return fail('This job asks for nothing the Mac can do.')
}
