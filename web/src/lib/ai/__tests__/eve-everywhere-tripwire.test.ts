/**
 * Tripwire (eve-everywhere): no in-process model call outside a short, pinned
 * allowlist.
 *
 * THE RULE. A Native Intelligence server model call goes through an eve agent (chat-agent,
 * skill-runner, coding-agent, work-agent, live-agent, utility,
 * onboarding-researcher). It never calls an AI SDK entry point or a provider
 * model in process. eve is where the ceilings, the session-ownership ACL,
 * cancellation and the usage row live, and an in-process call skips all four.
 * A new one-shot generation belongs on the `utility` agent
 * (src/lib/eve/utility/run-utility.ts), not on a fresh `generateText`.
 *
 * The ONLY exceptions (MODEL_CALL_ALLOWLIST, each pinned to one generator and
 * an exact call count):
 *   - the eval graders (judges.ts, match-proposals.ts): a founder exception,
 *     to be replaced by a decision-model gateway call later (follow-up);
 *   - embeddings, which use `embed()` / `embedMany()` (allowed values), and the
 *     in-browser voice-embedding worker (`@huggingface/transformers`).
 *   - decisions/providers/jev.ts: exactly one named eve/ai decide call,
 *     reachable only through the authorized, metered shared decision runner.
 *
 * WHAT IS ENFORCED, per non-test source file under src/, agents/, scripts/,
 * supabase/functions/, packages/ and evals/. Every file is parsed with the TypeScript
 * compiler, so comments, strings, templates, regexes and JSX text can never
 * read as code, and a stray backtick cannot hide the rest of a file. Deno-style
 * specifiers (`npm:x@1`, `https://esm.sh/x@1`) are read as the bare package.
 *   1. No identifier names a model entry point (MODEL_IDENTIFIERS: the four
 *      text/object generators, the AI SDK 7 agent, evaluation and stream-call
 *      APIs, and a LanguageModel's own `doGenerate` / `doStream`). Matching
 *      identifiers also catches aliases (`import { generateText as g }`),
 *      members (`x.generateText`) and string-keyed members
 *      (`gateway(m)['doGenerate']`). A string literal that is exactly
 *      `doGenerate` / `doStream` fails too (`Reflect.get(m, 'doGenerate')`,
 *      `const k = 'doStream'; m[k]`): neither is ever prose.
 *   2. A VALUE import from 'ai' (named import or re-export) must be in
 *      AI_VALUE_ALLOWSET, which holds only helpers that make no model call.
 *      Anything else fails, including transcribe, rerank, generateImage,
 *      experimental_decide, experimental_evaluate (its deprecated alias) and
 *      any export a future `ai` adds. The three
 *      allowed names that hand back a LanguageModel (`gateway`,
 *      `createGateway`, `wrapLanguageModel`) are further pinned to the files
 *      that use them (AI_VALUE_FILE_PINS). A namespace, default, dynamic `import()`,
 *      `require()` or `export *` of 'ai' always fails, because it would let a
 *      computed member get past rule 1, and so does ANY value reference to an
 *      'ai' subpath (`ai/internal` exports resolveLanguageModel; no subpath has
 *      an allowed use). So does an `import()` / `require()` whose specifier is
 *      not a string literal, and an indirect require (`const r = require`,
 *      `createRequire(...)`, `module.require`), because no rule can see what
 *      they load. Type-only imports pass this rule (rule 1 still applies to
 *      every identifier, types included).
 *   3. A value reference to a model provider package (`@ai-sdk/<provider>`,
 *      `@anthropic-ai/*`, `openai` / `@openai/*` (JSR), `@google/genai`,
 *      community AI SDK providers, `@huggingface/transformers`, ...) appears
 *      only in PROVIDER_IMPORT_ALLOWLIST, optionally pinned to named imports.
 *      `@ai-sdk/react` is the UI layer and is allowed.
 *   4. eve fails closed, like 'ai'. A VALUE reference to an eve subpath must be
 *      in EVE_SUBPATH_ALLOWSET (the subpaths the repo imports today), so a
 *      subpath a future eve adds fails until someone classifies it. eve's own
 *      in-process model modules are refused except the pinned Jev adapter:
 *      `eve/ai` (`decide()`, a decision model run in process; `evaluate()`
 *      before eve 0.72),
 *      `eve/models/*` (`anthropic()` / `openai()` direct provider models on
 *      their own API keys, and `auto()`, which runs an evaluation model to pick
 *      one), `eve/evals` (`defineEval`: its `t.judge()` runs the same
 *      `decide()` in the eve eval runner) and `eve/tools/agent-router` (its
 *      workflow calls `decide()` to route). From `eve/tools/approval`, the
 *      model-judged `auto()` policy is refused by name (EVE_REFUSED_NAMES), and
 *      so is any non-named reference to that module. None of these goes through
 *      an eve agent's ceilings or writes a usage row. A test walks the
 *      installed eve's import graph so a new subpath that reaches `decide()`
 *      or a provider model fails until classified. Adopting one (e.g. moving
 *      the graders to Jev through eve/ai or eve evals) is a founder decision
 *      that adds a pinned entry here.
 *      The one such decision so far (decision 19, docs/plans/eve-alignment.md
 *      §2): files under the root `evals/` directory may import
 *      EVALS_EVE_NAMES from `eve/evals` and `eve/evals/expect`, by name, and
 *      nothing else from them. There, `judge` and `score` are refused BY NAME
 *      as identifiers and string keys (`t.judge(...)`, `t.score(...)`,
 *      `judge(...)`, `t['judge']`, a `judge:` config key), and so is any
 *      computed member access (`t[name]`, whose key no rule can read), so an eval holds
 *      deterministic assertions only and eve's runner never reaches decide().
 *      Quality judging stays in the two exempt graders.
 *   5. `aiModel` from src/lib/ai/gateway.ts (a ready LanguageModel) is imported
 *      only by AIMODEL_IMPORT_ALLOWLIST (the graders).
 *   6. No `*_EVE_RUNTIME` flag or `shouldUseEve*Runtime` switch comes back.
 *      There is no non-eve twin left for a flag to select.
 *
 * NOT covered: a raw `fetch` to a provider's HTTP API, and a `doGenerate`
 * name assembled at runtime (`m['do' + 'Generate']`). Nothing does either
 * today, and review catches them more reliably than a textual rule.
 *
 * If this fails on your change: move the call onto an eve agent. Adding a file
 * to an allowlist, or a name to AI_VALUE_ALLOWSET, is a founder decision, not
 * a review nit.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'
import ts from 'typescript'

const ROOT = process.cwd()
const SCAN_ROOTS = ['src', 'agents', 'scripts', 'supabase/functions', 'packages', 'evals']
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/

/** The AI SDK text/object generators: the calls the exemptions are pinned to. */
const GENERATORS = ['generateText', 'streamText', 'generateObject', 'streamObject'] as const
type Generator = (typeof GENERATORS)[number]

/**
 * Identifiers that name an in-process model call wherever they appear in code.
 * Only names too specific to collide with an app function are listed here.
 * Generic names such as `transcribe` or `rerank` are caught by the import rule
 * instead, so an unrelated app function with that name does not trip it.
 */
const MODEL_IDENTIFIERS = new Set<string>([
  ...GENERATORS,
  'ToolLoopAgent',
  'Experimental_Agent',
  'experimental_streamLanguageModelCall',
  'createAgentUIStream',
  'createAgentUIStreamResponse',
  'pipeAgentUIStreamToResponse',
  'experimental_generateSpeech',
  'experimental_generateVideo',
  'experimental_transcribe',
  'experimental_streamTranscribe',
  'experimental_decide',
  'experimental_evaluate',
  // A LanguageModel's own call methods (gateway(x).doGenerate, aiModel(s).doStream,
  // a provider model). They bypass every AI SDK helper.
  'doGenerate',
  'doStream',
])

/**
 * The model-calling exports of the installed `ai` (7.x). A value import of any
 * of them already fails through AI_VALUE_ALLOWSET; the list names the reason in
 * the failure message and is checked disjoint from the allow-set below.
 */
const AI_MODEL_ENTRY_POINTS = [
  ...GENERATORS,
  'ToolLoopAgent',
  'Experimental_Agent',
  'experimental_streamLanguageModelCall',
  'createAgentUIStream',
  'createAgentUIStreamResponse',
  'pipeAgentUIStreamToResponse',
  'generateImage',
  'generateSpeech',
  'experimental_generateSpeech',
  'experimental_generateVideo',
  'experimental_startVideo',
  'transcribe',
  'experimental_transcribe',
  'experimental_streamTranscribe',
  'experimental_streamTranslate',
  'experimental_decide',
  'experimental_evaluate',
  'experimental_startBatch',
  'rerank',
] as const

/**
 * The only VALUE imports from 'ai' allowed anywhere. None of them calls a model
 * in process: tool/schema builders, embeddings (allowed by the rule), the
 * Gateway provider object (used to hand eve a model and for the Exa tool
 * definition), the Gateway provider factory (the local agent's model relay),
 * the model wrapper, a UI part guard and a text Response helper.
 */
const AI_VALUE_ALLOWSET = new Set<string>([
  'tool',
  'dynamicTool',
  'jsonSchema',
  'asSchema',
  'embed',
  'embedMany',
  'gateway',
  'createGateway',
  'wrapLanguageModel',
  'isToolUIPart',
  'createTextStreamResponse',
])

/**
 * Allowed 'ai' names that hand back a LanguageModel, pinned to the files that
 * use them: a LanguageModel's `doGenerate` can be reached without naming it
 * (`Reflect.get(m, k)`), so these stay where review has read the use.
 */
const AI_VALUE_FILE_PINS: Record<string, string[]> = {
  gateway: ['src/lib/ai/tools/web-search.ts', 'agents/utility/lib/spec-client.ts', 'agents/chat-agent/lib/browser-dispatch-model.ts'],
  wrapLanguageModel: ['agents/utility/lib/spec-client.ts', 'agents/chat-agent/lib/browser-dispatch-model.ts'],
  // Founder decision 7 (docs/plans/local-agents.md §9, 2026-10-20): the local agent's
  // Gateway provider pointed at the Native Intelligence model relay (a per-session token, the
  // gateway key stays on the server). It builds the LanguageModel handed to eve
  // in agents/local-agent/agent.ts; eve owns every call.
  createGateway: ['agents/local-agent/lib/model.ts'],
}

// A supported Eve step.started model adapter, not a second agent runtime. The
// middleware delegates the stream and permits one pre-dispatch recovery attempt;
// Eve still owns the loop, tool execution, persistence, and usage hooks. Pin the
// exact method and call sites so this exception cannot grow into another loop.
const STREAM_MIDDLEWARE_PATH = 'agents/chat-agent/lib/browser-dispatch-model.ts'
// Utility's supported model middleware forwards each Eve-owned call once and
// enforces its output/tool contract. It never invokes a provider model member
// or starts an independent model loop.
const UTILITY_MIDDLEWARE_PATH = 'agents/utility/lib/spec-client.ts'
// A fixed application permission reply; these method definitions implement the
// Eve model interface but must never invoke a model, import a provider, or fetch.
const PERMISSION_REPLY_PATH = 'agents/chat-agent/lib/browser-permission-handoff.ts'

interface Exemption {
  reason: string
  generator: Generator
  /** Exact number of `generator(...)` calls the file makes. */
  calls: number
}

/**
 * Files allowed to call one AI SDK generator directly, each pinned to that
 * generator and an exact call count. A second call, or any other model
 * identifier, in the same file fails. Paths are repo-relative POSIX paths.
 */
const MODEL_CALL_ALLOWLIST: Record<string, Exemption> = {
  'src/lib/evals/graders/judges.ts': {
    reason: 'founder exception: eval grader (judgeOnce); to move to a decision-model gateway call later',
    generator: 'generateObject',
    calls: 1,
  },
  'src/lib/evals/graders/match-proposals.ts': {
    reason: 'founder exception: eval grader (decideMatches); to move to a decision-model gateway call later',
    generator: 'generateObject',
    calls: 1,
  },
}

/**
 * Model provider packages (matched on the package name, so a subpath such as
 * `@ai-sdk/anthropic/internal` counts): a value reference to one builds or calls
 * a raw model. Includes community AI SDK providers (`*-ai-sdk-provider`,
 * `*-ai-provider`, `@openrouter/*`) and `@huggingface/transformers`, which runs
 * models in process.
 */
const PROVIDER_MODULE =
  /^(@ai-sdk\/(?!react$)[\w.-]+|@anthropic-ai\/[\w.-]+|openai|@openai\/[\w.-]+|@google\/(genai|generative-ai)|@mistralai\/[\w.-]+|groq-sdk|cohere-ai|@openrouter\/[\w.-]+|@huggingface\/transformers|(@[\w.-]+\/)?[\w.-]*-ai(-sdk)?-provider(-v\d+)?)$/

/**
 * eve's in-process model modules (rule 4): refused everywhere, no allowlist.
 * `eve/evals` itself only defines evals, but eve's eval runner executes each
 * `t.judge()` through `decide()`, so a defineEval file is an in-process
 * judge. `eve/evals/expect` (pure matchers) is not matched here; like any
 * subpath, it is allowed once it is in EVE_SUBPATH_ALLOWSET.
 */
const EVE_INPROCESS_MODULE = /^eve\/(ai|models)(\/.*)?$|^eve\/(evals|tools\/agent-router)$/

/**
 * eve subpaths the repo value-imports today (rule 4 fails closed on the rest).
 * Each is checked against the installed eve's import graph, and each must still
 * be imported somewhere. `eve/next` is imported by next.config.mjs.
 */
const EVE_SUBPATH_ALLOWSET = new Set<string>([
  'eve',
  'eve/channels/auth',
  'eve/channels/eve',
  'eve/client',
  'eve/context',
  'eve/hooks',
  'eve/instructions',
  // The chat agent's profile memory slot (always-on plan decision 4):
  // defineMemory + defineMemoryProvider over our own tables, recalled through an
  // app route. eve/memory/file (the Blob-backed built-in provider) stays out.
  'eve/memory',
  'eve/next',
  'eve/sandbox',
  // The local agent's host-folder provider (agents/local-agent/lib/host-folder-sandbox.ts):
  // defineSandboxProvider only. Classified 2026-10-20: it reaches no decide() and no provider module.
  'eve/sandbox/provider',
  'eve/sandbox/vercel',
  'eve/tools',
  'eve/tools/approval',
  // The Mac body's harness (contract C2, agents/chat-agent/lib/host.ts): eve's own
  // bash / read_file / write_file, bound to the host-folder fence; disabled in the
  // cloud. Classified 2026-10-21: sandbox tools, they reach no decide() and no provider module.
  'eve/tools/bash',
  'eve/tools/read_file',
  'eve/tools/web_fetch',
  'eve/tools/web_search',
  'eve/tools/write_file',
])

/**
 * Names refused from an allowed eve subpath because they run an unmetered
 * in-process `decide()`. Only named imports of these modules are allowed, so
 * a namespace or dynamic import cannot reach the refused name.
 */
const EVE_REFUSED_NAMES: Record<string, string[]> = {
  'eve/tools/approval': ['auto'], // model-judged approval policy; the repo uses `always`
}

/**
 * Decision 19 (deterministic eve evals): what a file under the root `evals/`
 * directory may value-import from eve's eval modules, by name. Everywhere
 * else `eve/evals` stays refused as in-process and `eve/evals/expect` stays
 * unclassified. `mockModel` (a fixture model), `matches` / `similarity`, the
 * loaders and the reporters are left out until an eval needs one (each entry
 * must stay in use, like EVE_SUBPATH_ALLOWSET).
 */
const EVALS_DIR = 'evals/'
const EVALS_EVE_NAMES: Record<string, string[]> = {
  'eve/evals': ['defineEval', 'defineEvalConfig'],
  'eve/evals/expect': ['includes', 'equals', 'satisfies'],
}
/**
 * Refused by name under `evals/` (decision 19): the LLM-as-judge surface
 * (`t.judge`, which the runner executes through decide(), and the `judge`
 * config) and `t.score`. As an identifier anywhere in code (a member, a call,
 * a destructured name, an object key) or a string literal (`t['judge']`).
 */
const EVALS_REFUSED_NAMES = new Set(['judge', 'score'])

/** Files allowed a value reference to a provider package, and which ones. */
const PROVIDER_IMPORT_ALLOWLIST: Record<string, { modules: string[]; names?: string[]; reason: string }> = {
  'src/lib/ai/gateway.ts': {
    modules: ['@ai-sdk/anthropic'],
    reason: 'the aiModel factory the graders use; building a model makes no call (rules 1 and 4 police its use)',
  },
  'src/lib/ai/gemini-embeddings.ts': {
    modules: ['@ai-sdk/google'],
    reason: 'Gemini embeddings; embeddings are allowed by the rule',
  },
  // The ChatGPT free tier's model: one file, a byte-identical copy per agent
  // (agents/chat-agent/lib/__tests__/chatgpt-plan-model-drift.test.ts).
  ...Object.fromEntries(
    ['chat-agent', 'utility', 'work-agent', 'skill-runner', 'live-agent', 'local-agent', 'web-research', 'onboarding-researcher'].map((agent) => [
      `agents/${agent}/lib/chatgpt-plan-model.ts`,
      {
        modules: ['@ai-sdk/openai'],
        // Pinned: only the factory, for one live model eve calls at step scope.
        names: ['createOpenAI'],
        reason:
          "the ChatGPT free tier's model (founder decision, 10-20, docs/plans/chatgpt-free-tier.md §5): a free user's " +
          "steps run inside the agent on their own plan, through the app's plan proxy, never the Gateway",
      },
    ]),
  ),
  'src/workers/voice-embedding-worker.ts': {
    modules: ['@huggingface/transformers'],
    // Pinned: the package also exports pipeline('text-generation'), a generative model in process.
    // `env` only points ONNX Runtime at its self-hosted files (security review 2026-10-31).
    names: ['AutoProcessor', 'AutoModel', 'env'],
    reason: 'in-browser speaker voice embeddings (ERes2Net); embeddings are allowed by the rule',
  },
  // Founder decision 7 (docs/plans/local-agents.md §9, 2026-10-20; L4 in docs/plans/teammate-agent.md):
  // the local agent's model on the person's Mac (Ollama / LM Studio on loopback). It builds the
  // LanguageModel handed to eve in agents/local-agent/agent.ts; eve owns every call.
  'agents/local-agent/lib/model.ts': {
    modules: ['@ai-sdk/openai-compatible'],
    names: ['createOpenAICompatible'],
    reason: "founder decision 7: the local agent's model on the Mac; building a model makes no call (eve owns every call)",
  },
}

/**
 * Files allowed an `import()` / `require()` whose specifier is not a literal:
 * test infrastructure only, never shipped code.
 */
const NONLITERAL_IMPORT_ALLOWLIST: Record<string, string> = {
  'src/test/integration.ts':
    'test helper resetRateLimitFor(modulePath): re-imports a route module under test after vi.resetModules()',
  'src/components/cloud-browser/live-view.tsx':
    "the live view loads noVNC from the static /cloud-browser/rfb.mjs (public/, built by scripts/cloud-browser/build-assets.mjs) when it opens; Vite refuses a literal import of a public/ file",
}

const GATEWAY_MODULE = 'src/lib/ai/gateway'
/** Files allowed to import `aiModel` (a ready LanguageModel) from src/lib/ai/gateway.ts. */
const AIMODEL_IMPORT_ALLOWLIST = ['src/lib/evals/graders/judges.ts', 'src/lib/evals/graders/match-proposals.ts']

/** Retired eve-vs-legacy switches, plus any future `*_EVE_RUNTIME` flag. */
const RUNTIME_FLAG = /\b[A-Z0-9_]*_EVE_RUNTIME\b|\bshouldUseEve(Chat|Agent)?Runtime\b/
const RETIRED_FLAGS = [
  'CHAT_EVE_RUNTIME',
  'NEXT_PUBLIC_CHAT_EVE_RUNTIME',
  'RUN_SKILL_EVE_RUNTIME',
  'AGENT_RUN_EVE_RUNTIME',
] as const
/** Build/runtime config outside the scan roots that could re-read a flag. */
const ROOT_CONFIG_FILES = ['next.config.mjs', 'vercel.json', 'package.json', 'vitest.config.ts']

// ── The analyzer ──────────────────────────────────────────────────────────────

type RefKind =
  | 'named' // import { a } from / export { a } from
  | 'namespace' // import * as x from / export * as x from
  | 'default' // import x from
  | 'export-star' // export * from
  | 'dynamic' // import('m')
  | 'require' // require('m') / import x = require('m')
  | 'side-effect' // import 'm'
  | 'unresolvable' // import(expr) / require(expr): the specifier is not a literal
  | 'indirect' // `require` used other than as `require('m')`, createRequire, x.require

interface ModuleRef {
  module: string
  kind: RefKind
  /** Imported (not local) names of the VALUE specifiers; type-only ones are dropped. */
  names: string[]
  /** The whole reference is type-only (`import type …`, or every specifier is `type`). */
  typeOnly: boolean
}

interface Facts {
  identifiers: string[]
  /** Calls whose callee is a bare identifier, counted by name. */
  calls: Map<string, number>
  /** Named member calls, used to pin the supported model middleware seam. */
  memberCalls: Map<string, number>
  methodDeclarations: Map<string, number>
  strings: string[]
  /** Element accesses whose key is not a string or number literal (`x[k]`). */
  computedAccess: number
  refs: ModuleRef[]
  /** Parse diagnostics; -1 if the compiler did not expose them. */
  syntaxErrors: number
}

function scriptKind(path: string): ts.ScriptKind {
  if (/\.[jt]sx$/.test(path)) return ts.ScriptKind.TSX
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/** Parse one file and collect what the rules need. Comments and JSX text are never visited. */
function analyze(src: string, path: string): Facts {
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, false, scriptKind(path))
  const facts: Facts = { identifiers: [], calls: new Map(), memberCalls: new Map(), methodDeclarations: new Map(), strings: [], computedAccess: 0, refs: [], syntaxErrors: 0 }
  // parseDiagnostics is not in the public typings, but createSourceFile always sets it.
  const diagnostics = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics
  facts.syntaxErrors = diagnostics ? diagnostics.length : -1

  const namedRef = (
    spec: string,
    clauseTypeOnly: boolean,
    elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[],
  ): ModuleRef => {
    const names = clauseTypeOnly ? [] : elements.filter((s) => !s.isTypeOnly).map((s) => (s.propertyName ?? s.name).text)
    return { module: spec, kind: 'named', names, typeOnly: clauseTypeOnly || names.length === 0 }
  }

  /** `require` identifiers that are the callee of a `require(...)` call or a typeof operand. */
  const plainRequire = new Set<ts.Node>()
  const indirect = (text: string) => facts.refs.push({ module: text, kind: 'indirect', names: [], typeOnly: false })

  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text
      facts.methodDeclarations.set(name, (facts.methodDeclarations.get(name) ?? 0) + 1)
    }
    // Indexed type queries cannot invoke a model (e.g. a middleware callback's
    // return type). Keep runtime element access checked by the rules below.
    if (ts.isIndexedAccessTypeNode(node)) {
      visit(node.objectType)
      return
    }
    if (ts.isTypeOfExpression(node) && ts.isIdentifier(node.expression)) plainRequire.add(node.expression)
    if (
      ts.isElementAccessExpression(node) &&
      !ts.isStringLiteralLike(node.argumentExpression) &&
      !ts.isNumericLiteral(node.argumentExpression)
    ) {
      facts.computedAccess++
    }
    if (ts.isIdentifier(node)) {
      facts.identifiers.push(node.text)
      // A `require` that is not called directly (`const r = require`, `module.require`,
      // `{ require }`) or any createRequire loads a module no rule can see.
      if (node.text === 'require' && !plainRequire.has(node)) indirect('require')
      if (node.text === 'createRequire') indirect('createRequire')
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      MODEL_IDENTIFIERS.has(node.argumentExpression.text)
    ) {
      // `x['generateText']` / x[`doGenerate`] names the member as surely as `x.generateText`.
      facts.identifiers.push(node.argumentExpression.text)
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      facts.strings.push(node.text)
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text
      const clause = node.importClause
      if (!clause) {
        facts.refs.push({ module: spec, kind: 'side-effect', names: [], typeOnly: false })
      } else {
        const typeOnly = clause.isTypeOnly
        if (clause.name) facts.refs.push({ module: spec, kind: 'default', names: [], typeOnly })
        const bindings = clause.namedBindings
        if (bindings && ts.isNamespaceImport(bindings)) {
          facts.refs.push({ module: spec, kind: 'namespace', names: [], typeOnly })
        } else if (bindings && ts.isNamedImports(bindings)) {
          facts.refs.push(namedRef(spec, typeOnly, bindings.elements))
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text
      const clause = node.exportClause
      if (!clause) facts.refs.push({ module: spec, kind: 'export-star', names: [], typeOnly: node.isTypeOnly })
      else if (ts.isNamespaceExport(clause)) facts.refs.push({ module: spec, kind: 'namespace', names: [], typeOnly: node.isTypeOnly })
      else facts.refs.push(namedRef(spec, node.isTypeOnly, clause.elements))
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      facts.refs.push({
        module: node.moduleReference.expression.text,
        kind: 'require',
        names: [],
        typeOnly: node.isTypeOnly,
      })
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      const arg = node.arguments[0]
      const literal = arg && ts.isStringLiteralLike(arg) ? arg.text : null
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require'
      if (isRequire) plainRequire.add(callee)
      if (isImport || isRequire) {
        facts.refs.push(
          literal === null
            ? { module: arg ? arg.getText(sf) : '', kind: 'unresolvable', names: [], typeOnly: false }
            : { module: literal, kind: isImport ? 'dynamic' : 'require', names: [], typeOnly: false },
        )
      }
      if (ts.isIdentifier(callee)) facts.calls.set(callee.text, (facts.calls.get(callee.text) ?? 0) + 1)
      if (ts.isPropertyAccessExpression(callee)) {
        const name = callee.name.text
        facts.memberCalls.set(name, (facts.memberCalls.get(name) ?? 0) + 1)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return facts
}

/** CDN / registry prefixes a Deno edge function (or a script) can load a package through. */
const PACKAGE_URL_PREFIX =
  /^(npm:|jsr:|https?:\/\/(esm\.sh|cdn\.skypack\.dev|esm\.run|cdn\.jsdelivr\.net\/npm|unpkg\.com|deno\.land\/x)\/)/

/**
 * A package specifier as `{ pkg, path }`: `pkg` is the package name, `path` the
 * package name plus any subpath, with a registry/CDN prefix, a version and a
 * query stripped (`npm:@ai-sdk/anthropic@2/internal` → pkg `@ai-sdk/anthropic`,
 * path `@ai-sdk/anthropic/internal`; `https://deno.land/x/openai@v4/mod.ts` →
 * pkg `openai`). Null for a local specifier or other URL (deno.land/std included).
 */
function packageOf(module: string): { pkg: string; path: string } | null {
  if (module.startsWith('.') || module.startsWith('@/') || module.startsWith('/')) return null
  const bare = module.replace(PACKAGE_URL_PREFIX, '').replace(/^\/+/, '').replace(/[?#].*$/, '')
  if (/^[a-z][a-z0-9+.-]*:/i.test(bare)) return null // node:, https: (not a known CDN), data:
  const m = /^((?:@[^/@]+\/)?[^/@]+)(?:@[^/]*)?(\/.*)?$/.exec(bare)
  if (!m) return null
  return { pkg: m[1], path: m[1] + (m[2] ?? '') }
}

/** A local module specifier as a repo-relative path without extension; null for a package. */
function resolveLocal(module: string, fromRel: string): string | null {
  let target: string
  if (module.startsWith('@/')) target = posix.join('src', module.slice(2))
  else if (module.startsWith('.')) target = posix.join(posix.dirname(fromRel), module)
  else return null
  return target.replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '')
}

/** Every rule 1–5 violation in one file, as human-readable reasons. */
function violations(relPath: string, facts: Facts): string[] {
  const out: string[] = []
  const exemption = Object.hasOwn(MODEL_CALL_ALLOWLIST, relPath) ? MODEL_CALL_ALLOWLIST[relPath] : undefined
  const inEvals = relPath.startsWith(EVALS_DIR)

  if (inEvals) {
    for (const name of new Set([...facts.identifiers, ...facts.strings])) {
      if (EVALS_REFUSED_NAMES.has(name)) out.push(`names \`${name}\` in an eval (decision 19: deterministic assertions only, no judge or score)`)
    }
    if (facts.computedAccess > 0) {
      out.push('computed member access in an eval (`x[key]` could reach t.judge unseen; use a literal key or a named member)')
    }
  }

  for (const name of new Set(facts.identifiers)) {
    if (!MODEL_IDENTIFIERS.has(name)) continue
    if (exemption && name === exemption.generator) continue
    if (relPath === STREAM_MIDDLEWARE_PATH && name === 'doStream') continue
    if (relPath === UTILITY_MIDDLEWARE_PATH && ['doStream', 'doGenerate'].includes(name) &&
      facts.calls.get(name) === 1 && !facts.memberCalls.has(name) &&
      facts.identifiers.filter(value => value === name).length === 2) continue
    if (relPath === PERMISSION_REPLY_PATH && ['doStream', 'doGenerate'].includes(name) &&
      facts.methodDeclarations.get(name) === 1 && facts.identifiers.filter(value => value === name).length === 1 &&
      !facts.calls.has(name) && !facts.memberCalls.has(name)) continue
    out.push(`names model entry point \`${name}\``)
  }
  for (const text of new Set(facts.strings)) {
    if (text === 'doGenerate' || text === 'doStream') out.push(`string literal names a LanguageModel's \`${text}\``)
  }

  for (const ref of facts.refs) {
    if (ref.typeOnly || ref.kind === 'side-effect') continue

    if (ref.kind === 'indirect') {
      out.push(`indirect \`${ref.module}\` (what it loads cannot be checked; call require('literal') directly)`)
      continue
    }

    if (ref.kind === 'unresolvable') {
      if (Object.hasOwn(NONLITERAL_IMPORT_ALLOWLIST, relPath)) continue
      out.push(`non-literal import()/require() of \`${ref.module}\` (the loaded module cannot be checked)`)
      continue
    }

    const pkg = packageOf(ref.module)
    const localModule = ref.module.startsWith('@/') ? `src/${ref.module.slice(2)}` :
      ref.module.startsWith('.') ? posix.normalize(posix.join(posix.dirname(relPath), ref.module)) : null
    if (localModule?.replace(/\.[cm]?[jt]s$/, '') === 'src/lib/ai/decisions/providers/jev' &&
        relPath !== 'src/lib/ai/decisions/run-decision.ts') {
      out.push('imports the Jev transport outside the metered decision runner')
      continue
    }

    if (pkg?.pkg === 'ai' && pkg.path !== 'ai') {
      out.push(`${ref.kind} reference to '${pkg.path}' (no 'ai' subpath has an allowed value use)`)
      continue
    }

    if (pkg?.path === 'ai') {
      if (ref.kind !== 'named') {
        out.push(`${ref.kind} reference to 'ai' (use named imports so each value is checked)`)
        continue
      }
      for (const name of ref.names) {
        if (AI_VALUE_ALLOWSET.has(name)) {
          const pinned = Object.hasOwn(AI_VALUE_FILE_PINS, name) ? AI_VALUE_FILE_PINS[name] : null
          if (pinned && !pinned.includes(relPath)) {
            out.push(`imports \`${name}\` from 'ai' (returns a LanguageModel; pinned to ${pinned.join(', ')})`)
          }
          continue
        }
        if (exemption && name === exemption.generator) continue
        const why = (AI_MODEL_ENTRY_POINTS as readonly string[]).includes(name)
          ? 'a model entry point'
          : 'not in AI_VALUE_ALLOWSET'
        out.push(`imports \`${name}\` from 'ai' (${why})`)
      }
      continue
    }

    if (pkg?.pkg === 'eve' && inEvals && Object.hasOwn(EVALS_EVE_NAMES, pkg.path)) {
      const allowed = EVALS_EVE_NAMES[pkg.path]
      if (ref.kind !== 'named') {
        out.push(`${ref.kind} reference to '${pkg.path}' (an eval imports ${allowed.join(', ')} by name)`)
      } else {
        for (const name of ref.names.filter((n) => !allowed.includes(n))) {
          out.push(`imports \`${name}\` from '${pkg.path}' (an eval may import only ${allowed.join(', ')})`)
        }
      }
      continue
    }

    if (pkg?.pkg === 'eve') {
      // Metered evaluation primitive, approved as part of the Jev decision service.
      // No generation exports, namespace imports, re-exports or other call sites.
      if (relPath === 'src/lib/ai/decisions/providers/jev.ts' && pkg.path === 'eve/ai' &&
          ref.kind === 'named' && ref.names.length === 1 && ref.names[0] === 'decide') continue
      if (EVE_INPROCESS_MODULE.test(pkg.path)) {
        out.push(`references eve's in-process model module '${pkg.path}' (runs a model outside every eve agent)`)
        continue
      }
      if (!EVE_SUBPATH_ALLOWSET.has(pkg.path)) {
        out.push(`references eve subpath '${pkg.path}', not in EVE_SUBPATH_ALLOWSET (classify it first)`)
        continue
      }
      const refused = Object.hasOwn(EVE_REFUSED_NAMES, pkg.path) ? EVE_REFUSED_NAMES[pkg.path] : null
      if (refused && ref.kind !== 'named') {
        out.push(`${ref.kind} reference to '${pkg.path}' (use named imports: it also exports ${refused.join(', ')})`)
      } else if (refused) {
        for (const name of ref.names.filter((n) => refused.includes(n))) {
          out.push(`imports \`${name}\` from '${pkg.path}' (runs an unmetered in-process decide())`)
        }
      }
      continue
    }

    if (pkg && PROVIDER_MODULE.test(pkg.pkg)) {
      const entry = Object.hasOwn(PROVIDER_IMPORT_ALLOWLIST, relPath) ? PROVIDER_IMPORT_ALLOWLIST[relPath] : null
      if (!entry?.modules.includes(pkg.pkg)) {
        out.push(`references model provider package '${pkg.pkg}'`)
      } else if (entry.names && ref.kind !== 'named') {
        out.push(`${ref.kind} reference to '${pkg.pkg}' (this file is pinned to named imports of ${entry.names.join(', ')})`)
      } else if (entry.names) {
        for (const name of ref.names.filter((n) => !entry.names!.includes(n))) {
          out.push(`imports \`${name}\` from '${pkg.pkg}' (this file is pinned to ${entry.names.join(', ')})`)
        }
      }
      continue
    }

    if (resolveLocal(ref.module, relPath) === GATEWAY_MODULE) {
      const exposesModel = ref.kind !== 'named' || ref.names.includes('aiModel')
      if (exposesModel && !AIMODEL_IMPORT_ALLOWLIST.includes(relPath)) {
        out.push('imports `aiModel` (a ready LanguageModel) from src/lib/ai/gateway')
      }
    }
  }
  return out
}

/** Flag names read in code: identifiers and string/template text (comments never count). */
function flagHits(facts: Facts): string[] {
  return [...facts.identifiers, ...facts.strings].filter((t) => RUNTIME_FLAG.test(t))
}

// ── The walk ──────────────────────────────────────────────────────────────────

/** Every non-test source file under a tree (skips __tests__, dot dirs, node_modules, dist). */
function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sources(full))
    else if (SOURCE_EXT.test(entry) && !TEST_FILE.test(entry)) out.push(full)
  }
  return out
}

const rel = (abs: string) => relative(ROOT, abs).split(sep).join('/')
const files = SCAN_ROOTS.flatMap((d) => sources(join(ROOT, d)))

// Every file is parsed once, up front at collection time (a few seconds for ~1.8k
// files), so no single test carries the parse cost against its timeout.
const parsed = new Map<string, Facts>(files.map((abs) => [abs, analyze(readFileSync(abs, 'utf8'), abs)]))
function scan(abs: string): Facts {
  const hit = parsed.get(abs)
  if (hit) return hit
  const facts = analyze(readFileSync(abs, 'utf8'), abs)
  parsed.set(abs, facts)
  return facts
}

// ── The installed eve's import graph (rule 4's classification check) ──────────

const EVE_ROOT = join(ROOT, 'node_modules/eve')

/** The installed eve's export map as [`eve/<subpath>`, entry file relative to the package]. */
function eveExports(): [string, string][] {
  const pkg = JSON.parse(readFileSync(join(EVE_ROOT, 'package.json'), 'utf8')) as {
    exports: Record<string, string | { import?: string; default?: string }>
  }
  const out: [string, string][] = []
  for (const [key, value] of Object.entries(pkg.exports)) {
    const entry = typeof value === 'string' ? value : (value.import ?? value.default)
    if (!entry?.endsWith('.js')) continue
    out.push([key === '.' ? 'eve' : `eve/${key.slice(2)}`, posix.normalize(entry)])
  }
  return out
}

/**
 * A module of the installed eve that runs a model in process: `decide()`
 * (dist/src/ai/decide.js, `evaluate()` before eve 0.72; every eve caller of
 * the AI SDK's experimental_decide goes through it), the model factories (dist/src/models/*, auto()),
 * or a bundled provider package (compiled @ai-sdk/<provider>, @anthropic-ai,
 * openai). The AI SDK's non-provider packages (provider interfaces, gateway,
 * otel, mcp, code-mode) are not targets: the gateway is how an eve agent's own
 * turn reaches its model.
 */
const EVE_MODEL_MODULE =
  /^dist\/src\/(ai\/decide\.js$|models\/|compiled\/(@ai-sdk\/(?!(provider|provider-utils|gateway|otel|mcp|code-mode)\/)[^/]+|@anthropic-ai|openai)\/)/

/** The import chain from `entry` to an EVE_MODEL_MODULE, or null. Follows relative and `#` imports. */
function eveModelPath(entry: string, seen = new Set<string>()): string[] | null {
  if (seen.has(entry)) return null
  seen.add(entry)
  if (EVE_MODEL_MODULE.test(entry)) return [entry]
  const full = join(EVE_ROOT, entry)
  if (!existsSync(full)) return null
  const src = readFileSync(full, 'utf8')
  for (const [, spec] of src.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)) {
    let next: string | null = null
    if (spec.startsWith('#compiled/')) next = posix.join('dist/src/compiled', spec.slice('#compiled/'.length))
    else if (spec.startsWith('#')) next = posix.join('dist/src', spec.slice(1))
    else if (spec.startsWith('.')) next = posix.join(posix.dirname(entry), spec)
    if (!next) continue
    const path = eveModelPath(next, seen)
    if (path) return [entry, ...path]
  }
  return null
}

const FAIL_HINT =
  "Every model call runs on eve (see this file's header). Move the call onto an eve agent: a " +
  'one-shot generation belongs on the utility agent (runUtilityTask). The eval graders and pinned ' +
  'metered Jev adapter are exempt, and embeddings use embed()/embedMany().'

describe('eve-everywhere: no in-process model call outside the allowlist', () => {
  it('finds the sources it is supposed to police', () => {
    // A silently-empty walk would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(500)
    const relFiles = files.map(rel)
    expect(relFiles).toContain('src/lib/eve/utility/run-utility.ts')
    expect(relFiles).toContain('agents/chat-agent/agent.ts')
    expect(relFiles).toContain('scripts/eve-prune-stuck-runs.ts')
    expect(relFiles).toContain('supabase/functions/stripe-webhook/index.ts')
    expect(relFiles).toContain('packages/ui/src/index.ts')
    expect(relFiles).toContain('evals/chat-agent/evals/evals.config.ts')
    expect(relFiles.filter((f) => f.startsWith('evals/') && f.endsWith('.eval.ts')).length).toBeGreaterThan(0)
    expect(relFiles.some((f) => f.includes('/__tests__/') || TEST_FILE.test(f))).toBe(false)
  })

  it('parses every scanned file without a syntax error, so no file is misread', () => {
    const broken = files.filter((f) => scan(f).syntaxErrors !== 0).map(rel)
    expect(broken).toEqual([])
  })

  it('no source breaks rules 1–5 (model identifiers, ai imports, eve in-process modules, provider packages, aiModel)', () => {
    const offenders = files
      .map((f) => ({ file: rel(f), why: violations(rel(f), scan(f)) }))
      .filter((o) => o.why.length > 0)
      .map((o) => `${o.file}: ${o.why.join('; ')}`)
    expect(offenders, FAIL_HINT).toEqual([])
  })

  it('pins each generator exemption to its one generator and exact call count', () => {
    for (const [path, { generator, calls }] of Object.entries(MODEL_CALL_ALLOWLIST)) {
      expect(existsSync(join(ROOT, path)), path).toBe(true)
      const facts = scan(join(ROOT, path))
      expect(facts.calls.get(generator) ?? 0, `${path}: ${generator}( calls`).toBe(calls)
      const others = [...new Set(facts.identifiers)].filter((n) => MODEL_IDENTIFIERS.has(n) && n !== generator)
      expect(others, `${path}: other model identifiers`).toEqual([])
    }
  })

  it('pins the browser dispatch middleware to streaming delegation and one recovery attempt', () => {
    const facts = scan(join(ROOT, STREAM_MIDDLEWARE_PATH))
    expect(facts.calls.get('doStream')).toBe(1)
    expect(facts.memberCalls.get('doStream')).toBe(2)
    expect([...new Set(facts.identifiers)].filter(name => MODEL_IDENTIFIERS.has(name) && name !== 'doStream')).toEqual([])
    expect(violations(STREAM_MIDDLEWARE_PATH, analyze('await model.doStream(params)', STREAM_MIDDLEWARE_PATH))).toEqual([])
    expect(violations(STREAM_MIDDLEWARE_PATH, analyze('await model.doGenerate(params)', STREAM_MIDDLEWARE_PATH))).toEqual(['names model entry point `doGenerate`'])
  })

  it('pins utility middleware to one forwarding callback per supported model method', () => {
    const facts = scan(join(ROOT, UTILITY_MIDDLEWARE_PATH))
    for (const name of ['doStream', 'doGenerate']) {
      expect(facts.calls.get(name)).toBe(1)
      expect(facts.memberCalls.has(name)).toBe(false)
      expect(facts.identifiers.filter(value => value === name)).toHaveLength(2)
      expect(violations(UTILITY_MIDDLEWARE_PATH, analyze(`async function wrap({ ${name} }) { return ${name}() }`, UTILITY_MIDDLEWARE_PATH))).toEqual([])
      expect(violations(UTILITY_MIDDLEWARE_PATH, analyze(`await model.${name}({})`, UTILITY_MIDDLEWARE_PATH))).not.toEqual([])
      expect(violations(UTILITY_MIDDLEWARE_PATH, analyze(`async function wrap({ ${name} }) { await ${name}(); return ${name}() }`, UTILITY_MIDDLEWARE_PATH))).not.toEqual([])
    }
  })

  it('permits only fixed-reply interface declarations in the browser permission handoff', () => {
    const facts = scan(join(ROOT, PERMISSION_REPLY_PATH))
    for (const name of ['doStream', 'doGenerate']) {
      expect(facts.methodDeclarations.get(name)).toBe(1)
      expect(facts.identifiers.filter(value => value === name)).toHaveLength(1)
      expect(facts.calls.get(name) ?? 0).toBe(0)
      expect(facts.memberCalls.get(name) ?? 0).toBe(0)
      expect(violations(PERMISSION_REPLY_PATH, analyze(`await model.${name}(params)`, PERMISSION_REPLY_PATH))).toContain(`names model entry point \`${name}\``)
    }
    expect(facts.identifiers).not.toContain('fetch')
    // eve/context, plus the pure step-index helper (no fetch, no provider, no model).
    expect(facts.refs.filter(ref => !ref.typeOnly).map(ref => ref.module)).toEqual(['eve/context', './resolver-step.js'])
    expect(scan(join(ROOT, 'agents/chat-agent/lib/resolver-step.ts')).refs).toEqual([])
  })

  it('keeps the provider, non-literal-import and aiModel allowlists honest (each entry still uses what it is exempted for)', () => {
    for (const [path, { modules, names }] of Object.entries(PROVIDER_IMPORT_ALLOWLIST)) {
      expect(existsSync(join(ROOT, path)), path).toBe(true)
      const valueRefs = scan(join(ROOT, path)).refs.filter((r) => !r.typeOnly)
      const used = valueRefs.map((r) => packageOf(r.module)?.pkg)
      for (const m of modules) expect(used, `${path} → ${m}`).toContain(m)
      const usedNames = valueRefs.filter((r) => modules.includes(packageOf(r.module)?.pkg ?? '')).flatMap((r) => r.names)
      for (const n of names ?? []) expect(usedNames, `${path} → pinned name ${n}`).toContain(n)
    }
    for (const path of Object.keys(NONLITERAL_IMPORT_ALLOWLIST)) {
      expect(existsSync(join(ROOT, path)), path).toBe(true)
      expect(
        scan(join(ROOT, path)).refs.some((r) => r.kind === 'unresolvable'),
        `${path} no longer needs its non-literal import exemption`,
      ).toBe(true)
    }
    for (const path of AIMODEL_IMPORT_ALLOWLIST) {
      const refs = scan(join(ROOT, path)).refs
      expect(
        refs.some((r) => resolveLocal(r.module, path) === GATEWAY_MODULE && r.names.includes('aiModel')),
        path,
      ).toBe(true)
    }
  })

  it('keeps AI_VALUE_FILE_PINS honest (each pinned file still imports its name, and every pinned name is allowed)', () => {
    for (const [name, paths] of Object.entries(AI_VALUE_FILE_PINS)) {
      expect(AI_VALUE_ALLOWSET.has(name), name).toBe(true)
      for (const path of paths) {
        expect(existsSync(join(ROOT, path)), path).toBe(true)
        const imports = scan(join(ROOT, path)).refs.some(
          (r) => packageOf(r.module)?.path === 'ai' && !r.typeOnly && r.names.includes(name),
        )
        expect(imports, `${path} no longer imports ${name}: drop it from the pin`).toBe(true)
      }
    }
  })

  it('keeps AI_VALUE_ALLOWSET honest (every allowed name is still imported somewhere)', () => {
    const imported = new Set(
      [...parsed.values()].flatMap((f) =>
        f.refs.filter((r) => packageOf(r.module)?.path === 'ai' && r.kind === 'named' && !r.typeOnly).flatMap((r) => r.names),
      ),
    )
    const unused = [...AI_VALUE_ALLOWSET].filter((n) => !imported.has(n))
    expect(unused, 'remove each unused name from AI_VALUE_ALLOWSET: an allow-set entry nothing needs is a hole').toEqual([])
  })

  it('AI_VALUE_ALLOWSET and AI_MODEL_ENTRY_POINTS name real exports of the installed ai, and never overlap', async () => {
    const exported = new Set(Object.keys(await import('ai')))
    for (const name of AI_VALUE_ALLOWSET) expect(exported.has(name), `allow-set: ${name}`).toBe(true)
    for (const name of AI_MODEL_ENTRY_POINTS) {
      expect(exported.has(name), `entry point: ${name}`).toBe(true)
      expect(AI_VALUE_ALLOWSET.has(name), `allow-set must not hold ${name}`).toBe(false)
    }
  })

  it('keeps EVE_SUBPATH_ALLOWSET honest (every entry is a real eve export that is still value-imported)', () => {
    const exported = new Set(eveExports().map(([sub]) => sub))
    const nextConfig = join(ROOT, 'next.config.mjs')
    const refs = [...parsed.values(), analyze(readFileSync(nextConfig, 'utf8'), nextConfig)].flatMap((f) =>
      f.refs.filter((r) => !r.typeOnly && packageOf(r.module)?.pkg === 'eve').map((r) => packageOf(r.module)!.path),
    )
    for (const sub of EVE_SUBPATH_ALLOWSET) {
      expect(exported.has(sub), `${sub} is not an export of the installed eve`).toBe(true)
      expect(EVE_INPROCESS_MODULE.test(sub), `${sub} is also refused as in-process`).toBe(false)
      expect(refs, `${sub} is no longer value-imported: drop it from EVE_SUBPATH_ALLOWSET`).toContain(sub)
    }
    for (const sub of Object.keys(EVE_REFUSED_NAMES)) expect(EVE_SUBPATH_ALLOWSET.has(sub), sub).toBe(true)
  })

  // Walks eve's dist import graph (eveModelPath) and imports eve/evals cold: fast
  // alone, past 5 s on a busy machine running the full suite.
  it('keeps EVALS_EVE_NAMES honest (real exports of the installed eve, each still imported under evals/, none reaching a model)', async () => {
    const modules: Record<string, Record<string, unknown>> = {
      'eve/evals': await import('eve/evals'),
      'eve/evals/expect': await import('eve/evals/expect'),
    }
    const evalRefs = [...parsed.entries()]
      .filter(([abs]) => rel(abs).startsWith(EVALS_DIR))
      .flatMap(([, f]) => f.refs.filter((r) => !r.typeOnly && r.kind === 'named'))
    for (const [sub, names] of Object.entries(EVALS_EVE_NAMES)) {
      const entry = eveExports().find(([s]) => s === sub)
      expect(entry, `${sub} is not an export of the installed eve`).toBeDefined()
      // The module itself never reaches decide(); only t.judge() does, in the runner, and it is refused by name.
      expect(eveModelPath(entry![1]), sub).toBeNull()
      for (const name of names) {
        expect(Object.hasOwn(modules[sub], name), `${sub} no longer exports ${name}`).toBe(true)
        const used = evalRefs.some((r) => packageOf(r.module)?.path === sub && r.names.includes(name))
        expect(used, `${name} from ${sub} is imported by no eval: drop it from EVALS_EVE_NAMES`).toBe(true)
      }
    }
    // The refused names are the judge and score surfaces of the installed eve.
    const types = readFileSync(join(EVE_ROOT, 'dist/src/evals/types.d.ts'), 'utf8')
    expect(types).toMatch(/readonly judge: JudgeContext/)
    expect(types).toMatch(/score\(evaluation: ScoreInput\): AssertionHandle/)
  }, 60_000)

  // Walks eve's dist import graph from every export: fast alone, past 5 s on a
  // busy machine running the full suite.
  it("every installed eve export that reaches decide() or a provider model is refused by rule 4 or name-pinned", () => {
    const reaching = eveExports()
      .map(([sub, entry]) => ({ sub, path: eveModelPath(entry) }))
      .filter((e) => e.path !== null)
    // The walk must see something, or a moved dist layout would make this vacuous.
    expect(reaching.map((e) => e.sub)).toEqual(
      expect.arrayContaining(['eve/ai', 'eve/models', 'eve/models/anthropic', 'eve/tools/approval']),
    )
    const unclassified = reaching
      .filter((e) => !EVE_INPROCESS_MODULE.test(e.sub) && !Object.hasOwn(EVE_REFUSED_NAMES, e.sub))
      .map((e) => `${e.sub}: ${e.path!.join(' -> ')}`)
    expect(unclassified, 'classify each: refuse it in EVE_INPROCESS_MODULE or pin its model-running names').toEqual([])
  }, 60_000)

  // The same dist import-graph walk, from three entries: slow on a busy machine.
  it('the rule-4 reasons still hold in the installed eve (eval runner judges in process; approval exports auto)', () => {
    // eve/evals does not import decide() itself; the runner that executes a defineEval's t.judge() does.
    expect(eveModelPath('dist/src/evals/runner/execute-task.js')).not.toBeNull()
    expect(eveModelPath('dist/src/evals/judge.js')).not.toBeNull()
    const approval = eveExports().find(([sub]) => sub === 'eve/tools/approval')
    expect(approval).toBeDefined()
    expect(readFileSync(join(EVE_ROOT, approval![1]), 'utf8')).toMatch(/\bauto\b/)
    // eve/evals/expect (pure matchers) never reaches a model, so it is classifiable as allowed when adopted.
    const expectEntry = eveExports().find(([sub]) => sub === 'eve/evals/expect')
    expect(expectEntry && eveModelPath(expectEntry[1])).toBeNull()
  }, 60_000)

  it('embeddings stay on embed()/embedMany(), which this rule deliberately allows', () => {
    const facts = scan(join(ROOT, 'src/lib/ai/embeddings.ts'))
    expect(['embed', 'embedMany', 'aiEmbed'].some((n) => (facts.calls.get(n) ?? 0) > 0)).toBe(true)
    expect(violations('src/lib/ai/embeddings.ts', facts)).toEqual([])
  })
})

describe('eve-everywhere: the retired eve runtime flags never come back', () => {
  it('no scanned source reads a *_EVE_RUNTIME flag or a shouldUseEve*Runtime switch', () => {
    const offenders = files.filter((f) => flagHits(scan(f)).length > 0).map(rel)
    expect(
      offenders,
      'eve is the only runtime: there is no legacy twin for a flag to select. ' +
        `Retired: ${RETIRED_FLAGS.join(', ')}.`,
    ).toEqual([])
  })

  it('no build/runtime config file names a retired flag', () => {
    for (const file of ROOT_CONFIG_FILES) {
      const full = join(ROOT, file)
      if (!existsSync(full)) continue
      const text = readFileSync(full, 'utf8')
      const hit = file.endsWith('.json') ? RUNTIME_FLAG.test(text) : flagHits(analyze(text, full)).length > 0
      expect(hit, file).toBe(false)
    }
  })

  it('the test env scrub no longer lists a retired flag', () => {
    const setup = readFileSync(join(ROOT, 'src/test/setup.ts'), 'utf8')
    for (const flag of RETIRED_FLAGS) expect(setup, flag).not.toMatch(new RegExp(`\\b${flag}\\b`))
  })
})

describe('the analyzer the tripwire trusts', () => {
  const check = (src: string, path = 'src/lib/x/probe.ts') => violations(path, analyze(src, join(ROOT, path)))
  const flags = (src: string) => flagHits(analyze(src, join(ROOT, 'src/lib/x/probe.ts')))

  it('pins metered decisions to the Jev adapter and only its named decide import', () => {
    const path = 'src/lib/ai/decisions/providers/jev.ts'
    expect(check("import { decide } from 'eve/ai'", path)).toEqual([])
    expect(check("import { decide } from 'eve/ai'")).not.toEqual([])
    // The pre-0.72 name is no longer the pinned one.
    expect(check("import { evaluate } from 'eve/ai'", path)).not.toEqual([])
    expect(check("import * as ai from 'eve/ai'", path)).not.toEqual([])
    expect(check("import { generateText } from 'eve/ai'", path)).not.toEqual([])
    expect(check("const ai = await import('eve/ai')", path)).not.toEqual([])
    expect(scan(join(ROOT, path)).calls.get('decide')).toBe(1)
    expect(check("import { evaluateJev } from '@/lib/ai/decisions/providers/jev'")).not.toEqual([])
    expect(check("import { evaluateJev } from './providers/jev'", 'src/lib/ai/decisions/run-decision.ts')).toEqual([])
  })

  it('flags a call, an aliased import and a member in code', () => {
    expect(check('const r = await generateText({ model })')).not.toEqual([])
    expect(check("import { streamText as st } from 'ai'")).not.toEqual([])
    expect(check('await ai.generateObject({})')).not.toEqual([])
    expect(check('const x = `${await streamObject({})}`')).not.toEqual([])
  })

  it('ignores comments, strings, templates and regex literals', () => {
    expect(check('// the pre-port generateText( call')).toEqual([])
    expect(check('/* streamText() */ const a = 1')).toEqual([])
    expect(check("log('generateObject failed')")).toEqual([])
    expect(check('const s = `streamObject ${n} done`')).toEqual([])
    expect(check('const re = /generateText\\(/')).toEqual([])
  })

  it('a lone backtick in JSX text does not hide a later import and call', () => {
    const src = [
      'export const Hint = () => <p>Press ` to open</p>',
      "import { generateText } from 'ai'",
      'export const run = () => generateText({})',
    ].join('\n')
    const found = check(src, 'src/components/probe.tsx')
    expect(found).toContain('names model entry point `generateText`')
    expect(found).toContain("imports `generateText` from 'ai' (a model entry point)")
  })

  it('a regex holding a backtick after `)` does not hide a later call', () => {
    expect(check('if (ok) /`/.test(s)\nstreamText({})')).toContain('names model entry point `streamText`')
  })

  it('refuses the AI SDK 7 model entry points that are not text/object generators', () => {
    expect(check("import { ToolLoopAgent } from 'ai'\nnew ToolLoopAgent({ model }).generate()")).not.toEqual([])
    expect(check("import { transcribe } from 'ai'")).toEqual(["imports `transcribe` from 'ai' (a model entry point)"])
    expect(check("import { rerank, generateImage } from 'ai'")).toHaveLength(2)
    expect(check("import { experimental_toolCaller } from 'ai'")).toEqual([
      "imports `experimental_toolCaller` from 'ai' (not in AI_VALUE_ALLOWSET)",
    ])
    expect(check("export { streamText } from 'ai'")).not.toEqual([])
  })

  it('does not flag an app function that shares a generic AI SDK name', () => {
    expect(check('export async function transcribe(audio: Blob) { return audio }\ntranscribe(b)')).toEqual([])
  })

  it('allows the allow-set, type-only imports and the UI layer', () => {
    expect(check("import { tool, jsonSchema, embed } from 'ai'")).toEqual([])
    expect(check("import type { LanguageModel, UIMessage } from 'ai'")).toEqual([])
    expect(check("import { type ToolLoopAgentSettings, tool } from 'ai'")).toEqual([])
    expect(check("import { useChat } from '@ai-sdk/react'")).toEqual([])
    expect(check("import type { LanguageModelV3 } from '@ai-sdk/provider'")).toEqual([])
  })

  it("refuses every non-named reference to 'ai'", () => {
    expect(check("import * as ai from 'ai'")).toHaveLength(1)
    expect(check("const m = await import('ai'); m['generateText']({})")).toEqual([
      'names model entry point `generateText`',
      "dynamic reference to 'ai' (use named imports so each value is checked)",
    ])
    expect(check("const { streamText: s } = require('ai')")).not.toEqual([])
    expect(check("import ai = require('ai')")).toHaveLength(1)
    expect(check("export * from 'ai'")).toHaveLength(1)
  })

  it("refuses a LanguageModel's own doGenerate / doStream", () => {
    expect(check("gateway('anthropic/claude-haiku-4.5').doGenerate({ prompt })")).toEqual([
      'names model entry point `doGenerate`',
    ])
    expect(check('await model.doStream(opts)')).toEqual(['names model entry point `doStream`'])
  })

  it('refuses a doGenerate / doStream reached without an identifier or element-access literal', () => {
    expect(
      check("import { gateway } from 'ai'\nconst m = gateway('x')\nawait Reflect.get(m, 'doGenerate').call(m, o)", 'src/lib/ai/tools/web-search.ts'),
    ).toEqual(["string literal names a LanguageModel's `doGenerate`"])
    expect(check("const k = 'doStream'\nawait m[k](o)")).toEqual(["string literal names a LanguageModel's `doStream`"])
    expect(check("log('doGenerate failed')")).toEqual([])
    expect(check("type StreamResult = ReturnType<WrapArguments['doStream']>")).toEqual([])
  })

  it('pins gateway, createGateway and wrapLanguageModel to the files that use them', () => {
    expect(check("import { createGateway } from 'ai'")).toEqual([
      "imports `createGateway` from 'ai' (returns a LanguageModel; pinned to agents/local-agent/lib/model.ts)",
    ])
    expect(check("import { createGateway } from 'ai'", 'agents/local-agent/agent.ts')).toHaveLength(1)
    expect(check("import { createGateway } from 'ai'", 'agents/local-agent/lib/model.ts')).toEqual([])
    expect(check("import { createGateway } from '@ai-sdk/gateway'", 'agents/local-agent/lib/model.ts')).toEqual([
      "references model provider package '@ai-sdk/gateway'",
    ])
    expect(check("import { gateway } from 'ai'", 'agents/local-agent/lib/model.ts')).toHaveLength(1)
    expect(check("import { gateway } from 'ai'")).toEqual([
      "imports `gateway` from 'ai' (returns a LanguageModel; pinned to src/lib/ai/tools/web-search.ts, agents/utility/lib/spec-client.ts, agents/chat-agent/lib/browser-dispatch-model.ts)",
    ])
    expect(check("import { wrapLanguageModel } from 'ai'", 'src/lib/ai/tools/web-search.ts')).toHaveLength(1)
    expect(check("import { gateway, wrapLanguageModel } from 'ai'", 'agents/utility/lib/spec-client.ts')).toEqual([])
    expect(check("import { gateway, wrapLanguageModel } from 'ai'", STREAM_MIDDLEWARE_PATH)).toEqual([])
    expect(check("import { gateway } from 'ai'", 'src/lib/ai/tools/web-search.ts')).toEqual([])
    expect(check("import type { GatewayModelId } from 'ai'")).toEqual([])
  })

  it("refuses any value reference to an 'ai' subpath", () => {
    expect(check("import * as i from 'ai/internal'")).toEqual([
      "namespace reference to 'ai/internal' (no 'ai' subpath has an allowed value use)",
    ])
    expect(check("import { resolveLanguageModel } from 'ai/internal'")).toHaveLength(1)
    expect(check("import type { X } from 'ai/internal'")).toEqual([])
  })

  it('refuses an indirect require (aliased, createRequire, x.require) but not typeof require', () => {
    expect(check("const r = require\nconst m = r('ai')")).toEqual([
      "indirect `require` (what it loads cannot be checked; call require('literal') directly)",
    ])
    expect(check("import { createRequire } from 'node:module'\ncreateRequire(import.meta.url)('ai')")).not.toEqual([])
    expect(check("module.require('ai')")).toHaveLength(1)
    expect(check("if (typeof require === 'function') go()")).toEqual([])
    expect(check("const z = require('zod')")).toEqual([])
    expect(check("import zod = require('zod')")).toEqual([])
  })

  it('refuses a string-keyed member that names a model entry point', () => {
    expect(
      check("import { gateway } from 'ai'\nawait gateway('m')['doGenerate']({})", 'src/lib/ai/tools/web-search.ts'),
    ).toEqual(['names model entry point `doGenerate`', "string literal names a LanguageModel's `doGenerate`"])
    expect(check('await model[`doStream`](o)')).toEqual([
      'names model entry point `doStream`',
      "string literal names a LanguageModel's `doStream`",
    ])
    expect(check("x['streamText']({})")).toEqual(['names model entry point `streamText`'])
    expect(check("const k = cfg['model']")).toEqual([])
  })

  it('refuses experimental_decide, experimental_evaluate and experimental_startBatch from ai', () => {
    expect(check("import { experimental_decide } from 'ai'")).toEqual([
      'names model entry point `experimental_decide`',
      "imports `experimental_decide` from 'ai' (a model entry point)",
    ])
    expect(check("import { experimental_evaluate } from 'ai'")).toEqual([
      'names model entry point `experimental_evaluate`',
      "imports `experimental_evaluate` from 'ai' (a model entry point)",
    ])
    expect(check("import { experimental_startBatch } from 'ai'")).toEqual([
      "imports `experimental_startBatch` from 'ai' (a model entry point)",
    ])
  })

  it("refuses eve's in-process model modules (eve/ai, eve/models/*) and allows the rest of eve", () => {
    expect(check("import { decide } from 'eve/ai'\nawait decide({ questions, state })")).toEqual([
      "references eve's in-process model module 'eve/ai' (runs a model outside every eve agent)",
    ])
    expect(check("import { anthropic } from 'eve/models/anthropic'")).toHaveLength(1)
    expect(check("import { openai } from 'eve/models/openai'")).toHaveLength(1)
    expect(check("import { auto } from 'eve/models'")).toHaveLength(1)
    expect(check("const { decide } = await import('eve/ai')")).toHaveLength(1)
    expect(check("import { withEve } from 'eve/next'")).toEqual([])
    expect(check("import { defineTool } from 'eve/tools'")).toEqual([])
    expect(check("import type { AuthFn } from 'eve/channels/auth'")).toEqual([])
  })

  it('refuses eve/evals (t.judge runs decide) and eve/tools/agent-router; type-only imports pass', () => {
    expect(check("import { defineEval } from 'eve/evals'")).toEqual([
      "references eve's in-process model module 'eve/evals' (runs a model outside every eve agent)",
    ])
    expect(check("import type { EveEvalJudgeConfig } from 'eve/evals'")).toEqual([])
    expect(check("import { agentRouter } from 'eve/tools/agent-router'")).toHaveLength(1)
    // eve/evals/expect is pure, but like any subpath it must be classified before use.
    expect(check("import { includes } from 'eve/evals/expect'")).toEqual([
      "references eve subpath 'eve/evals/expect', not in EVE_SUBPATH_ALLOWSET (classify it first)",
    ])
  })

  it('decision 19: evals/ may import defineEval and the pure matchers by name, nothing more', () => {
    const ev = 'evals/chat-agent/evals/safety/probe.eval.ts'
    expect(check("import { defineEval } from 'eve/evals'", ev)).toEqual([])
    expect(check("import { defineEvalConfig } from 'eve/evals'", 'evals/chat-agent/evals/evals.config.ts')).toEqual([])
    expect(check("import { includes, equals, satisfies } from 'eve/evals/expect'", ev)).toEqual([])
    expect(check("import { similarity } from 'eve/evals/expect'", ev)).toEqual([
      "imports `similarity` from 'eve/evals/expect' (an eval may import only includes, equals, satisfies)",
    ])
    expect(check("import type { ToolStub, EveEvalTurn } from 'eve/evals'", ev)).toEqual([])
    expect(check("import { defineEval, mockModel } from 'eve/evals'", ev)).toEqual([
      "imports `mockModel` from 'eve/evals' (an eval may import only defineEval, defineEvalConfig)",
    ])
    expect(check("import * as e from 'eve/evals'", ev)).toHaveLength(1)
    expect(check("const e = await import('eve/evals')", ev)).toHaveLength(1)
    expect(check("export * from 'eve/evals/expect'", ev)).toHaveLength(1)
    expect(check("import { loadYaml } from 'eve/evals/loaders'", ev)).toEqual([
      "references eve subpath 'eve/evals/loaders', not in EVE_SUBPATH_ALLOWSET (classify it first)",
    ])
    expect(check("import { Braintrust } from 'eve/evals/reporters'", ev)).toHaveLength(1)
    // Only the root evals/ directory: the same import anywhere else is still refused.
    expect(check("import { defineEval } from 'eve/evals'", 'src/lib/evals/probe.eval.ts')).toEqual([
      "references eve's in-process model module 'eve/evals' (runs a model outside every eve agent)",
    ])
    expect(check("import { defineEval } from 'eve/evals'", 'scripts/evals/probe.ts')).toHaveLength(1)
    expect(check("import { includes } from 'eve/evals/expect'", 'agents/chat-agent/evals/x.ts')).toHaveLength(1)
  })

  it('decision 19: evals/ refuses judge and score by name, however they are reached', () => {
    const ev = 'evals/chat-agent/evals/safety/probe.eval.ts'
    const refusedJudge = 'names `judge` in an eval (decision 19: deterministic assertions only, no judge or score)'
    const refusedScore = 'names `score` in an eval (decision 19: deterministic assertions only, no judge or score)'
    expect(check("t.judge('cites a source')", ev)).toEqual([refusedJudge])
    expect(check("t.judge('x', { on: turn.message }).atLeast(0.7)", ev)).toEqual([refusedJudge])
    expect(check('t.score(0.5).label("x").gate(0.9)', ev)).toEqual([refusedScore])
    expect(check("judge('x')", ev)).toEqual([refusedJudge])
    expect(check("t['judge']('x')", ev)).toEqual([refusedJudge])
    expect(check('const { judge } = t\njudge("x")', ev)).toEqual([refusedJudge])
    expect(check('const j = t.judge\nj("x")', ev)).toEqual([refusedJudge])
    expect(check("export default defineEvalConfig({ judge: { model: 'typesafe-ai/jev' } })", 'evals/chat-agent/evals/evals.config.ts')).toEqual([refusedJudge])
    expect(check('handle.score(value)', ev)).toEqual([refusedScore])
    // Deterministic assertions, comments and prose pass.
    expect(check("t.calledTool('x'); t.notCalledTool('y'); t.toolOrder(['a', 'b']); t.check(m, includes('z'))", ev)).toEqual([])
    expect(check("// never t.judge('x') here\nconst note = 'a judge of character'", ev)).toEqual([])
    // A computed key could spell judge at runtime: refused under evals/, literal keys pass.
    const refusedComputed = 'computed member access in an eval (`x[key]` could reach t.judge unseen; use a literal key or a named member)'
    expect(check("const k = 'ju' + 'dge'\nt[k]('x')", ev)).toEqual([refusedComputed])
    expect(check('for (const key of keys) t[key]', ev)).toEqual([refusedComputed])
    expect(check("const first = rows[0]\nconst x = obj['name']\nconst y = obj[`plain`]", ev)).toEqual([])
    expect(check('const v = rows[i]', 'src/lib/x/probe.ts')).toEqual([])
    // Outside evals/ the names are ordinary words (a grader's judgeOnce, a score column).
    expect(check('const score = row.score\nfunction judge() {}', 'src/lib/x/probe.ts')).toEqual([])
  })

  it('fails closed on eve subpaths nobody has classified', () => {
    expect(check("import { fileMemory } from 'eve/memory/file'")).toEqual([
      "references eve subpath 'eve/memory/file', not in EVE_SUBPATH_ALLOWSET (classify it first)",
    ])
    expect(check("import { x } from 'eve/some-future-subpath'")).toHaveLength(1)
    expect(check("import type { X } from 'eve/memory/file'")).toEqual([])
    // eve/memory itself is classified (decision 4): the profile slot's defineMemory.
    expect(check("import { defineMemory, defineMemoryProvider } from 'eve/memory'")).toEqual([])
    expect(check("import { defineAgent } from 'eve'")).toEqual([])
    expect(check("import { defineAgent } from 'npm:eve@0.66'", 'supabase/functions/probe/index.ts')).toEqual([])
  })

  it("refuses eve/tools/approval's model-judged auto() and any non-named reference to that module", () => {
    expect(check("import { always } from 'eve/tools/approval'")).toEqual([])
    expect(check("import { auto } from 'eve/tools/approval'")).toEqual([
      "imports `auto` from 'eve/tools/approval' (runs an unmetered in-process decide())",
    ])
    expect(check("import { always, auto as a } from 'eve/tools/approval'")).toHaveLength(1)
    expect(check("import * as approval from 'eve/tools/approval'")).toHaveLength(1)
    expect(check("const m = await import('eve/tools/approval')")).toHaveLength(1)
  })

  it('refuses an import()/require() whose specifier is not a literal', () => {
    expect(check("const m = 'ai'\nawait import(m)")).toEqual([
      'non-literal import()/require() of `m` (the loaded module cannot be checked)',
    ])
    expect(check('const x = require(name)')).toHaveLength(1)
    expect(check('await import(`./locale/${lang}`)')).toHaveLength(1)
    expect(check('await import(`./fixed`)')).toEqual([])
  })

  it('reads Deno / CDN specifiers as the bare package', () => {
    const edge = 'supabase/functions/probe/index.ts'
    expect(check("import { generateObject } from 'npm:ai@7'", edge)).toHaveLength(2)
    expect(check("import { tool } from 'https://esm.sh/ai@7.0.0?target=denonext'", edge)).toEqual([])
    expect(check("import { embed } from 'npm:ai'", edge)).toEqual([])
    expect(check("import { createAnthropic } from 'npm:@ai-sdk/anthropic@2'", edge)).toEqual([
      "references model provider package '@ai-sdk/anthropic'",
    ])
    expect(check("import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.40'", edge)).toHaveLength(1)
    expect(check("import { evaluate } from 'npm:eve@0.66/ai'", edge)).toHaveLength(1)
    expect(check("import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'", edge)).toEqual([])
    expect(check("import Stripe from 'https://esm.sh/stripe@22.1.0?target=denonext'", edge)).toEqual([])
    // OpenAI's official Deno paths.
    expect(check("import OpenAI from 'jsr:@openai/openai'", edge)).toEqual([
      "references model provider package '@openai/openai'",
    ])
    expect(check("import OpenAI from 'https://deno.land/x/openai@v4.24.0/mod.ts'", edge)).toEqual([
      "references model provider package 'openai'",
    ])
    expect(check("import { generateText } from 'https://deno.land/x/ai@7/mod.ts'", edge)).not.toEqual([])
  })

  it('refuses community AI SDK providers, provider subpaths and in-process transformers', () => {
    expect(check("import { createOpenRouter } from '@openrouter/ai-sdk-provider'")).toHaveLength(1)
    expect(check("import { ollama } from 'ollama-ai-provider-v2'")).toHaveLength(1)
    expect(check("import { x } from 'workers-ai-provider'")).toHaveLength(1)
    expect(check("import { x } from '@ai-sdk/anthropic/internal'")).toEqual([
      "references model provider package '@ai-sdk/anthropic'",
    ])
    expect(check("import { pipeline } from '@huggingface/transformers'")).toHaveLength(1)
    const worker = 'src/workers/voice-embedding-worker.ts'
    expect(check("import { AutoProcessor, AutoModel, type Tensor } from '@huggingface/transformers'", worker)).toEqual([])
    expect(check("import { AutoModel, pipeline } from '@huggingface/transformers'", worker)).toEqual([
      "imports `pipeline` from '@huggingface/transformers' (this file is pinned to AutoProcessor, AutoModel, env)",
    ])
    expect(check("import * as hf from '@huggingface/transformers'", worker)).toHaveLength(1)
    expect(check("import { z } from 'zod'")).toEqual([])
  })

  it('confines provider packages and aiModel to their allowlists', () => {
    expect(check("import { createAnthropic } from '@ai-sdk/anthropic'")).toEqual([
      "references model provider package '@ai-sdk/anthropic'",
    ])
    expect(check("const { openai } = await import('@ai-sdk/openai')")).toHaveLength(1)
    expect(check("import Anthropic from '@anthropic-ai/sdk'")).toHaveLength(1)
    expect(check("import OpenAI from 'openai'")).toHaveLength(1)
    expect(check("import { createAnthropic } from '@ai-sdk/anthropic'", 'src/lib/ai/gateway.ts')).toEqual([])
    expect(check("import { google } from '@ai-sdk/google'", 'src/lib/ai/gateway.ts')).toHaveLength(1)
    const localModel = 'agents/local-agent/lib/model.ts'
    expect(check("import { createOpenAICompatible } from '@ai-sdk/openai-compatible'", localModel)).toEqual([])
    expect(check("import { createOpenAICompatible } from '@ai-sdk/openai-compatible'", 'agents/local-agent/agent.ts')).toHaveLength(1)
    expect(check("import * as oac from '@ai-sdk/openai-compatible'", localModel)).toHaveLength(1)
    expect(check("import { createAnthropic } from '@ai-sdk/anthropic'", localModel)).toHaveLength(1)

    expect(check("import { aiModel } from '@/lib/ai/gateway'")).toHaveLength(1)
    expect(check("import { aiModel } from '../gateway'", 'src/lib/ai/tools/probe.ts')).toHaveLength(1)
    expect(check("import * as g from './gateway'", 'src/lib/ai/probe.ts')).toHaveLength(1)
    expect(check("import { aiModel } from '@/lib/ai/gateway'", 'src/lib/evals/graders/judges.ts')).toEqual([])
  })

  it('a pinned exemption allows only its generator', () => {
    const judges = 'src/lib/evals/graders/judges.ts'
    expect(check("import { generateObject } from 'ai'\ngenerateObject({})", judges)).toEqual([])
    expect(check("import { generateText } from 'ai'\ngenerateText({})", judges)).toHaveLength(2)
  })

  it('reads flag names from code and strings, never from comments', () => {
    expect(flags("process.env['CHAT_EVE_RUNTIME']")).toEqual(['CHAT_EVE_RUNTIME'])
    expect(flags('process.env.AGENT_RUN_EVE_RUNTIME')).toEqual(['AGENT_RUN_EVE_RUNTIME'])
    expect(flags('if (shouldUseEveRuntime()) go()')).toEqual(['shouldUseEveRuntime'])
    expect(flags('// retired: CHAT_EVE_RUNTIME')).toEqual([])
  })
})
