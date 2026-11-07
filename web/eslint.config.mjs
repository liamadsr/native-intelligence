import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
  ...nextVitals,
  {
    rules: {
      "@next/next/no-img-element": "off",

      // ── eslint-plugin-react-hooks v7 (React-Compiler-powered rules) ──
      // eslint-config-next@16 turns these on as errors. Several of them flag
      // deliberate, correct patterns in this codebase rather than bugs, so we
      // tune severity per rule below (genuine-bug sites — static-components,
      // purity — are fixed in code and stay at "error").

      // Fires on legitimate fetch-on-open, reset-on-prop-change, SSR-safe
      // client-API reads, and guarded prop-resync effects (46 such sites, all
      // verified correct). This is React's opt-in "you-might-not-need-an-effect"
      // advisory, not a bug detector — off to avoid drowning real signal.
      "react-hooks/set-state-in-effect": "off",

      // Flags the "latest-value ref" idiom (`xRef.current = value` at body top,
      // read only inside callbacks/effects) that this codebase uses pervasively
      // for stable callbacks and React.memo bail-out, plus a few benign
      // ref-reads during render. All 25 sites verified safe — off.
      "react-hooks/refs": "off",

      // All sites are assignments inside event handlers (window.location.href)
      // or requestAnimationFrame draw-loop callbacks (animRef.current = raf()),
      // never on the render path. Kept as "warn" to retain the guardrail for a
      // future genuinely-in-render mutation without failing CI.
      "react-hooks/immutability": "warn",

      // Compiler missed-optimization advisory: the manual useMemo deps are
      // correct at runtime (no missing dep, no stale closure) but the compiler
      // declines to further-optimize. Rewriting deps would change recompute
      // frequency for zero correctness gain, so keep as "warn".
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },
  {
    // The globals rule flags reassigning an outer variable during render. Every
    // occurrence is the standard test-harness capture pattern
    // (`let api; function Harness(){ api = useHook(...) }`) used only to drive
    // or inspect a hook/provider from the test body. Disable in tests; the rule
    // stays active as an error for production code.
    files: ["**/__tests__/**", "**/*.test.{ts,tsx}", "**/*.bench.test.{ts,tsx}"],
    rules: {
      "react-hooks/globals": "off",
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
