// The cloud browser's static assets (docs/plans/cloud-browser.md, C2, C3), served at
// /cloud-browser/*. Runs before `next build`. Generated, not committed (.gitignore).
// - relay.mjs + agent_runtime.js: the relay and hub the host starts in each sandbox.
// - rfb.mjs: noVNC's RFB core for the live view, loaded only when a live view opens.
//   Where noVNC isn't installed (a worktree sharing another's node_modules), point
//   NOVNC_DIR at an unpacked @novnc/novnc@1.4.0 package.
import { build } from 'esbuild'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const out = 'public/cloud-browser'
mkdirSync(out, { recursive: true })
const version = process.env.VERCEL_GIT_COMMIT_SHA || 'dev'
const result = await build({
  entryPoints: ['src/lib/cloud-browser/relay/main.ts'],
  outfile: `${out}/relay.mjs`,
  bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: true, sourcemap: false,
  // The relay checks it against /api/browser-relay/next; a relay from another build restarts.
  define: { 'process.env.CLOUD_BROWSER_RELAY_BUILD': JSON.stringify(version) },
  // ws reaches for optional native speedups the sandbox never has.
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: `// Native Intelligence cloud browser relay ${version}\nimport { createRequire as __dial8Require } from 'node:module'; const require = __dial8Require(import.meta.url);` },
  logLevel: 'warning', metafile: true,
})
// Nothing that only runs inside Next belongs in the sandbox.
const forbidden = Object.keys(result.metafile.inputs).filter(path => /node_modules\/(server-only|next|@supabase)\//.test(path))
if (forbidden.length) throw new Error(`the relay bundle pulled in server-only modules: ${forbidden.join(', ')}`)
copyFileSync('src/lib/cloud-browser/cdp/agent_runtime.js', `${out}/agent_runtime.js`)

// esbuild resolves noVNC itself; NOVNC_DIR stands in for a missing install.
const novnc = process.env.NOVNC_DIR
if (novnc && !existsSync(join(novnc, 'lib/rfb.js'))) throw new Error(`NOVNC_DIR has no lib/rfb.js: ${novnc}`)
await build({
  stdin: { contents: "import RFB from '@novnc/novnc/lib/rfb.js'; export default RFB", resolveDir: process.cwd(), loader: 'js' },
  ...(novnc ? { alias: { '@novnc/novnc': novnc } } : {}),
  outfile: `${out}/rfb.mjs`,
  bundle: true, platform: 'browser', format: 'esm', target: 'es2020', minify: true,
  banner: { js: '// noVNC 1.4.0 RFB core (MPL-2.0, https://github.com/novnc/noVNC), bundled for Native Intelligence\'s live view' },
  logLevel: 'warning',
}).catch(error => {
  throw new Error(`noVNC didn't bundle; is @novnc/novnc installed? (or set NOVNC_DIR to an unpacked @novnc/novnc@1.4.0): ${error.message}`)
})
console.log(`cloud browser assets ${version}: ${out}/{relay.mjs,agent_runtime.js,rfb.mjs}`)
