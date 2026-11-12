/**
 * studio_product: run one Studio product job the Native Intelligence agent prepared (its id is in this job's request):
 * set the product in this folder up for the Studio, list its components, capture one as footage or a still, or make
 * out-of-date component layers again. The product's own code runs only inside this job's fence: the runner
 * (../studio/runner.ts) is ONE command of the job, so the folder stays read-only, nothing reaches the network, and
 * the result goes to the app over the job's own session token (../studio/app-client.ts). The answer is one or two
 * sentences for the model.
 *
 * A Mac host slot (contract C2): the Mac build adds it to the Native Intelligence agent as tools/studio_product.ts
 * (scripts/local-agent/mac-body.sh); the cloud body has none. The runner ships beside the server as
 * .output/studio/studio.tgz (../studio/build.sh), or where LOCAL_AGENT_STUDIO_ARCHIVE points.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { macToolGuard } from '../../chat-agent/lib/mac-guard.js'
import { macStudioApp } from '../studio/app-client.js'
import { runStudioJob, type JobSandbox } from '../studio/job.js'

/** Where the runner archive is: LOCAL_AGENT_STUDIO_ARCHIVE, else .output/studio/studio.tgz beside the server. */
export function studioArchivePath(env: Readonly<Record<string, string | undefined>> = process.env, entry = process.argv[1] ?? ''): string {
  return env.LOCAL_AGENT_STUDIO_ARCHIVE || join(dirname(entry), '..', 'studio', 'studio.tgz')
}

export default defineTool({
  description:
    'Run a Studio product job that the Native Intelligence agent prepared for this folder: your request names it ("Studio product job <id>"). ' +
    "It reads the job from the app, renders the product's own React components inside this folder's fence (the folder stays read-only), and sends the result to the Studio. Call it once with that job id; never for anything else.",
  inputSchema: z.object({ job_id: z.string().uuid().describe('The Studio product job id from your request.') }),
  async execute({ job_id }, ctx) {
    // Never run after a Stop (../../chat-agent/lib/mac-guard.ts).
    await macToolGuard(ctx.session?.auth)
    const app = macStudioApp()
    if (typeof app === 'string') return app
    const browser = process.env.LOCAL_AGENT_STUDIO_BROWSER
    try {
      return await runStudioJob(job_id, {
        sandbox: (await ctx.getSandbox()) as unknown as JobSandbox,
        app,
        archive: async () => new Uint8Array(await readFile(studioArchivePath())),
        ...(browser ? { env: { STUDIO_BROWSER: browser } } : {}),
        signal: ctx.abortSignal,
      })
    } catch (error) {
      return `The Studio job could not run: ${error instanceof Error ? error.message : String(error)}`
    }
  },
})
