import { defineConfig, configDefaults } from 'vitest/config'
import path from 'path'

// `npm run build` is `vitest run && next build`, and a shell that builds may
// hold NODE_ENV=production for the whole command. Vite reads NODE_ENV to decide
// `isProduction` AFTER loading this file, and in production mode its resolver turns a node built-in
// (`node:path`, `node:fs`, ...) imported by a jsdom test into the bare
// `__vite-browser-external` id, which loads as `export default {}` — every
// named import is undefined ("join is not a function"). In dev mode it emits
// `__vite-browser-external:node:path`, which vite-node strips back to the real
// built-in. `test.env` below only reaches the workers, and vitest's own
// `NODE_ENV ??= 'test'` never overrides an explicit value, so force it here, in
// the main process, before Vite resolves. Scoped to the vitest process; the
// subsequent `next build` is a separate process and still sees production.
// (Object.assign because Next's types declare NODE_ENV read-only.)
Object.assign(process.env, { NODE_ENV: 'test' })

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      // eve agent code lives outside src/ (agents/*) — colocated __tests__
      // there cover the researcher's pure helpers and tool owner-derivation.
      // Vite resolves their `.js` relative imports to the `.ts` sources
      // (moduleResolution: bundler).
      'agents/**/*.test.ts',
    ],
    // `eve dev` writes runtime + snapshot copies of each agent (including its
    // colocated __tests__) into gitignored `.eve/` dirs. Those aren't in
    // vitest's default exclude, so the broad `agent(s)/**` includes above would
    // otherwise collect stale duplicate copies of every test. Extend the
    // defaults rather than replace them.
    exclude: [...configDefaults.exclude, '**/.eve/**'],
    setupFiles: ['./src/test/setup.ts'],
    // Force React's development build during the test run. `react/index.js`
    // only exports `act` from the dev build; under NODE_ENV=production (which a
    // shell that builds may hold for the whole `vitest run && next build`) it
    // loads the prod build where `act` is undefined → "act is not a function" in the two
    // jsdom render tests. Scoped to the test process only; does not affect the
    // subsequent `next build`.
    env: { NODE_ENV: 'test' },
    // Process `novel` (and the `react-tweet` it re-exports) through Vite rather
    // than letting Node load them natively. react-tweet ships raw CSS MODULES,
    // which Node cannot `import` — that single `.css` specifier is why every
    // suite touching the note editor had to mock the whole editor stack, and
    // why editor regressions were only ever pinned against hand-rolled mirrors
    // of NoteEditor instead of the component itself. Inlined, Vite resolves the
    // stylesheet and the REAL NoteEditor mounts in jsdom (see
    // note-editor-focused-reconcile.test.tsx).
    server: { deps: { inline: ['novel', 'react-tweet'] } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/__tests__/**',
        'src/test/**',
        'src/**/*.d.ts',
        'src/app/**/page.tsx',
        'src/app/**/layout.tsx',
        'src/app/**/loading.tsx',
        'src/app/**/error.tsx',
        'src/app/**/not-found.tsx',
        'src/sanity/**',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
