# DevKit

[![CI](https://github.com/Karan071/devkit-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Karan071/devkit-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/devkit-quality.svg)](https://www.npmjs.com/package/devkit-quality)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

DevKit is a deterministic, offline code-quality scanner for JavaScript and TypeScript repositories. It walks a project, parses every source file with the TypeScript compiler, and reports a 0-10 "code quality" score backed by concrete, file-and-line findings — dead code, unused dependencies, excessive complexity, duplication, unsafe error handling, unsafe TypeScript, security anti-patterns, architecture violations, and repository hygiene issues.

It does not call an LLM, an API, or the network. Every finding is reproducible from the source tree alone.

```bash
npx devkit-quality scan
```

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ DevKit • Repository Quality Scan                                             │
│ ~/projects/my-app                                                            │
╰──────────────────────────────────────────────────────────────────────────────╯

  8.5 / 10   grade  B   Good
  █████████████████████████████████████████░░░░░░░
  Biggest score drains:
  1. COMPLEX002 High cognitive complexity function  -0.49 (54 findings)
  2. COMPLEX001 High cyclomatic complexity function -0.47 (54 findings)
  3. DEAD009    Unused export                       -0.18 (48 findings)

── SCAN COVERAGE 1.7s · via git (respects .gitignore) ──────────────────────────
  144 files found   93 analyzed as JS/TS   23 other files secret-scanned
  Project: dependencies installed • tsconfig.json • Vitest • 42 entry points

── CATEGORIES ──────────────────────────────────────────────────────────────────
  Dead Code         8.9  ███████████████████████████░░░  ✔ clean
  Dependencies     10.0  ██████████████████████████████  ✔ clean
  Complexity        2.9  █████████░░░░░░░░░░░░░░░░░░░░░  114 findings
  Type Safety       9.0  ███████████████████████████░░░  23 findings
  Security          9.6  █████████████████████████████░  1 finding
  Architecture      n/a  not scored — add "architecture.layers" to .devkitrc.json
  ...

── FINDINGS 138 total ──────────────────────────────────────────────────────────
  ● 35 high   ● 80 medium   ● 23 low

── HOTSPOTS files that cost the most points ────────────────────────────────────
  ● src/moduleGraph.ts         23 findings  worst: high
  ...

── TOP ISSUES worst finding per category ───────────────────────────────────────
  [HIGH]  High cyclomatic complexity function  Complexity · COMPLEX001
  ┃ Function "runKnip" has cyclomatic complexity 21 (max 10).
  ┃ → Split the function into smaller units or reduce branching.
  ┃ src/adapters.ts:107
      106 │ /** knip's JSON reporter (v5): unused files, exports, types and ...
    > 107 │ function runKnip(root: string, options: AdapterOptions): { findings: ...
          │ ^
  ...
```

## Table of contents

- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Project layout](#project-layout)
- [Setup](#setup)
- [Usage](#usage)
- [Configuration](#configuration)
- [Scoring model](#scoring-model)
- [Output formats](#output-formats)
- [CI/CD integration](#cicd-integration)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## How it works

A scan runs in a single pass over the repository:

1. **Discovery** — list files with `git ls-files` (exact `.gitignore` semantics; falls back to a filesystem walk outside git), apply include/exclude and `.devkitignore`, skip generated/minified files and build output in package roots, and split files into JS/TS sources (`.js`/`.jsx`/`.ts`/`.tsx`/`.mjs`/`.cjs`/`.mts`/`.cts`, fully analyzed) and other text files (configs, `.env`, YAML, other languages — secret-scanned).
2. **Parse & type-check** — build one `ts.Program` (via the TypeScript Compiler API) covering every discovered file, with `noUnusedLocals`/`noUnusedParameters`/`noImplicitAny` enabled so the compiler itself surfaces dead bindings and implicit `any`.
3. **Module graph** — resolve imports, `require()`, dynamic `import()`, TypeScript path aliases, and re-exports into an internal dependency graph (edges, reverse edges, entry points, re-export targets).
4. **Rules** — each rule module receives a shared `RuleContext` (files, program, module graph, config, `package.json`) and returns `Finding[]`.
5. **Scoring** — findings are weighted by severity × confidence, normalized against repository size, and rolled up into per-category and overall scores.
6. **Reporting** — the same `ScanSummary` is rendered as colored terminal output, JSON, Markdown, or SARIF.

Design principle carried over from the project's PRD (`devkit-slop-scanner-final-prd.md`): never use an LLM to answer a question static analysis can answer deterministically. DevKit only measures *observable* characteristics of the code (unused, duplicated, overly complex, unsafe) — it makes no claim about authorship or subjective quality.

## Architecture

```
                 devkit scan
                      |
                      v
              scanRepository()               scanner.ts
                      |
        +-------------+--------------+
        |             |              |
   walkDirectory  createProgram   buildModuleGraph
   (discovery.ts) (ast/parse.ts)  (moduleGraph.ts)
        |             |              |
        +-------------+--------------+
                      |
                      v
                 RuleContext                  context.ts
                      |
        +----+----+----+----+----+----+----+----+----+----+
        |    |    |    |    |    |    |    |    |    |    |
     deadCode|complexity|duplication|errorHandling|redundancy
        dependencies   typescript  javascript  security
                  architecture   hygiene
                 (src/rules/*.ts, definitions in rules.ts)
        +----+----+----+----+----+----+----+----+----+----+
                      |
                      v
                  Finding[]                   finding.ts / types.ts
                      |
                      v
                computeScores()               scoring.ts
                      |
                      v
                 ScanSummary
                      |
        +-------------+-------------+-------------+
        |             |             |              |
   formatTerminal  formatJson  formatMarkdown  formatSarif
                 (reporters.ts)
```

### Core modules

| Module | Responsibility |
| --- | --- |
| [`src/cli.ts`](src/cli.ts) | Commander-based CLI entry point; wires commands to the scanner and reporters. |
| [`src/scanner.ts`](src/scanner.ts) | Orchestrates a full scan: discovery → program → module graph → rules → metrics → scoring. |
| [`src/discovery.ts`](src/discovery.ts) | Directory walking, file filtering, generated/test-file detection, line counting. |
| [`src/ignore.ts`](src/ignore.ts) | Loads `.gitignore` and `.devkitignore` patterns for scan filtering. |
| [`src/ast/parse.ts`](src/ast/parse.ts) | Creates the shared `ts.Program` (compiler options, script-kind detection). |
| [`src/ast/walk.ts`](src/ast/walk.ts) | AST traversal helpers (`forEachNode`, function-like detection, line/column lookup). |
| [`src/ast/comments.ts`](src/ast/comments.ts) | Collects and caches comment ranges for hygiene checks and suppressions. |
| [`src/moduleResolution.ts`](src/moduleResolution.ts) | Resolves modules using TypeScript config, path aliases, and a per-scan cache. |
| [`src/moduleGraph.ts`](src/moduleGraph.ts) | Resolves imports/exports/re-exports into an internal dependency graph; detects entry points and import cycles. |
| [`src/suppressions.ts`](src/suppressions.ts) | Applies `devkit-disable-next-line` and `devkit-disable-file` directives to findings. |
| [`src/cliLogic.ts`](src/cliLogic.ts) | Pure finding-filter and quality-gate logic used by the CLI. |
| [`src/config.ts`](src/config.ts) | Loads/writes `.devkitrc.json`; rule enable/disable and threshold overrides. |
| [`src/context.ts`](src/context.ts) | `RuleContext` type shared by every rule module. |
| [`src/rules.ts`](src/rules.ts) | Declarative catalog of every rule's metadata (id, severity, confidence, docs) — consumed by `devkit rules`/`devkit explain`. |
| [`src/rules/*.ts`](src/rules) | One module per category; each exports a `run*Rules(context)` function that returns `Finding[]`. |
| [`src/finding.ts`](src/finding.ts) | `buildFinding()` constructs a `Finding` with a stable id. |
| [`src/scoring.ts`](src/scoring.ts) | Converts findings into category scores and an overall 0-10 score. |
| [`src/reporters.ts`](src/reporters.ts) | Terminal, JSON, Markdown, and SARIF renderers, plus baseline-compare output. |
| [`src/terminal.ts`](src/terminal.ts) | ANSI color helpers, score bar, code-frame rendering, spinner. |
| [`src/glob.ts`](src/glob.ts) | Minimal glob-to-regex matcher used for config include/exclude patterns. |
| [`src/fileKind.ts`](src/fileKind.ts) | Classifies each file (production, test, type-test, example, benchmark, script, fixture) and declares which kinds each rule applies to. |
| [`src/dependencyUsage.ts`](src/dependencyUsage.ts) | Finds dependency usage that no import shows: config files, stylesheets, tool shorthand names, executables, peers (from `node_modules` or lockfiles). |
| [`src/frameworkConventions.ts`](src/frameworkConventions.ts) | Files a framework loads by convention (currently Next.js), so they are not reported as unused. |

### Rule categories implemented

| Category | Rule IDs | File |
| --- | --- | --- |
| Dead code | `DEAD002`–`DEAD011` | [`src/rules/deadCode.ts`](src/rules/deadCode.ts) |
| Dependencies | `DEP001`–`DEP003` | [`src/rules/dependencies.ts`](src/rules/dependencies.ts) |
| Complexity | `COMPLEX001`–`COMPLEX005` | [`src/rules/complexity.ts`](src/rules/complexity.ts) |
| Duplication | `DUP001` | [`src/rules/duplication.ts`](src/rules/duplication.ts) |
| Error handling | `ERR001`–`ERR004` | [`src/rules/errorHandling.ts`](src/rules/errorHandling.ts) |
| Redundant logic | `REDUNDANT001`–`REDUNDANT002` | [`src/rules/redundancy.ts`](src/rules/redundancy.ts) |
| TypeScript safety | `TS001`–`TS003` | [`src/rules/typescript.ts`](src/rules/typescript.ts) |
| JavaScript hygiene | `JS001`–`JS002` | [`src/rules/javascript.ts`](src/rules/javascript.ts) |
| Security | `SEC001`–`SEC014` (SEC006 reserved) | [`src/rules/security.ts`](src/rules/security.ts) |
| Architecture | `ARCH001` | [`src/rules/architecture.ts`](src/rules/architecture.ts) |
| Hygiene | `HYGIENE001`–`HYGIENE004` | [`src/rules/hygiene.ts`](src/rules/hygiene.ts) |

Run `devkit rules` for the live list, or `devkit explain <RULE_ID>` for a rule's full writeup (why it matters, example, fix classification).

> **Note:** `devkit-slop-scanner-final-prd.md` in the repo root is the original product-requirements document and describes a larger target surface (incremental caching, monorepo-aware scoring, rule presets, a V2 LLM layer, and more). The table above reflects what is currently implemented in `src/`; treat the PRD as the roadmap, not the current feature set. Minimal `devkit-disable-next-line` and `devkit-disable-file` suppressions are implemented; monorepo-aware dependency scoring (DEP001/DEP002) is implemented.

## Project layout

```
cli-tool/
├── bin/devkit.js          # Shebang entry point, requires dist/cli.js
├── src/
│   ├── cli.ts             # Command definitions (scan, report, metrics, rules, explain, baseline, fix, init)
│   ├── scanner.ts         # scanRepository() — the main pipeline
│   ├── discovery.ts       # File walking/filtering
│   ├── moduleGraph.ts     # Import/export graph + cycle detection
│   ├── config.ts          # .devkitrc.json loading
│   ├── context.ts         # RuleContext type
│   ├── rules.ts           # Rule metadata catalog
│   ├── rules/             # One file per rule category (the detectors)
│   ├── ast/               # TypeScript Compiler API helpers
│   ├── finding.ts          # Finding constructor
│   ├── scoring.ts          # Score computation
│   ├── reporters.ts        # terminal/json/markdown/sarif output
│   ├── terminal.ts         # Color/formatting primitives
│   └── __tests__/          # Vitest suite, one file per rule category + e2e
├── dist/                   # Compiled output (tsc), what bin/devkit.js actually runs
├── tsconfig.json
└── package.json
```

## Setup

Requires Node.js `^22.12.0 || ^24.0.0 || >=26.0.0` (the version range the test suite's dependencies require; Node 18 and 20 are not supported).

```bash
# install dependencies
npm install

# build (compiles src/ -> dist/, which bin/devkit.js requires)
npm run build

# run against the current directory
node dist/cli.js scan
# or, once linked/installed as a package:
devkit scan
```

For local development without a build step, run the CLI directly through `tsx`:

```bash
npm run dev -- scan        # tsx src/cli.ts scan
npm run scan                # shortcut for the above
```

To use the `devkit` command globally from this checkout:

```bash
npm run build
npm link        # exposes `devkit` on PATH via the "bin" entry in package.json
```

## Usage

Initialize a config file in a target project:

```bash
devkit init
# writes .devkitrc.json with default include/exclude globs

devkit init --interactive
# scans the project, then proposes ignores from its frameworks (build output) and from the
# directories that hold most of the findings, asking before each one. --yes accepts only the
# framework build-output ignores, without asking.
```

Run a full scan (defaults to colored terminal output):

```bash
devkit scan
devkit scan ../other-repo              # scan another directory (every scanning command takes an optional path)
devkit scan --json                     # machine-readable JSON (ScanSummary)
devkit scan --format markdown          # Markdown report
devkit scan --format sarif             # SARIF, for code-scanning platforms
devkit scan --category dead-code       # only one category (dead-code, security, type-safety, ...)
devkit scan --severity high            # only one severity level
devkit scan --since origin/main        # only findings on lines changed since a git ref (for PR checks)
devkit scan --with gitleaks,knip       # also run these tools when installed and merge their findings
devkit scan --all                      # include low-confidence findings (see "Scoring")
```

Other commands:

```bash
devkit metrics            # repository metrics: LOC, function/class counts, largest files, etc.
devkit report              # full Markdown report (same as `scan --format markdown`)
devkit rules               # list every built-in rule (id, title, category)
devkit explain DEAD010     # full explanation of a single rule
devkit baseline create      # snapshot the current score to .devkit/baseline.json
devkit baseline compare     # compare current score against the stored baseline
devkit fix                  # preview the safe fixes
devkit fix --write          # apply them: unused imports, console.log/debug, var -> let/const
devkit doctor               # are dependencies installed? which tsconfig, workspaces, frameworks, entry points?
```

`devkit fix --write` is conservative. It removes exactly the import bindings the compiler reports as unused, deletes `console.log`/`console.debug`/`debugger` statements that are not the only statement in their block, and turns a top-level `var` into `const`/`let` only when it is declared once, never used before its declaration or from a hoisted function, and lives in a module. Every changed file is re-checked, and left untouched if a fix would add a compile error. Review the diff and run your tests afterwards.

`--with` runs `gitleaks` and `knip` if they are on the `PATH` or in `node_modules/.bin`, and merges their findings (rule ids `GITLEAKS:*` and `KNIP:*`) into the score and the SARIF output. A tool that is missing or prints something unreadable is reported as a warning; the built-in scan still completes. Matched secret text from gitleaks is never copied into a finding.

## Configuration

`devkit init` creates `.devkitrc.json` in the project root:

```json
{
  "project": { "name": "my-project" },
  "scan": {
    "include": ["src/**", "packages/**"],
    "exclude": ["node_modules/**", "dist/**", "coverage/**", ".git/**", ".devkit/**"]
  },
  "rules": {}
}
```

By default, noise-prone rules (style, typing, complexity, duplication, dead code, and injection/crypto/TLS security rules) judge shipped code only: findings in tests, examples, benchmarks, fixtures and scaffolds are hidden, and the scan summary shows how many were. Secret detection (`SEC001`) still scans everywhere. To see everything:

```json
{ "scan": { "includeNonProduction": true } }
```

TypeScript strictness follows your own `tsconfig.json`: implicit-`any` is reported only if you enabled `noImplicitAny`/`strict`, and never in plain JavaScript unless `checkJs` is on.

Per-rule overrides live under `rules`:

```json
{
  "rules": {
    "COMPLEX001": { "max": 15 },
    "JS001": { "enabled": false }
  }
}
```

Architecture-layer rules (`ARCH001`) are opt-in and only produce findings once configured:

```json
{
  "architecture": {
    "layers": {
      "controllers": { "match": ["src/controllers/**"], "cannotImport": ["database"] },
      "database": { "match": ["src/database/**"], "cannotImport": [] }
    }
  }
}
```

## Scoring model

Each finding is weighted by `severity × confidence` ([`src/scoring.ts`](src/scoring.ts)); findings in test files count at half weight. Quality categories are normalized against lines of code (in 500-line chunks), so the same number of findings costs less in a larger repository. Security is normalized only by the square root of size, capped at 3×, because one leaked key is just as serious in a large repository. Category scores are combined into the overall score using these weights:

| Category | Weight |
| --- | ---: |
| Dead code | 15% |
| Complexity | 15% |
| Security | 15% |
| Dependencies | 10% |
| Duplication | 10% |
| Error handling | 10% |
| Type safety | 10% |
| Redundant logic | 5% |
| Architecture | 5% |
| Hygiene | 5% |

- **Security cap:** a HIGH/CRITICAL security finding with HIGH or CERTAIN confidence outside test files caps the overall score at 6.9, however clean the rest of the code is.
- **Architecture** is only scored when `architecture.layers` is configured; otherwise it is shown as `n/a` and the other weights are rescaled.
- **Production code only:** the headline score and category scores count findings in shipped code (and scripts that run for real). Findings in tests, examples, benchmarks and fixtures are never scored, even with `--audit`.
- **No single rule dominates:** each rule's cost to a category grows linearly up to 2 points and only logarithmically beyond, so 500 `any`s cannot flatten Type Safety on their own. The three rules that cost the most overall points are listed under "Biggest score drains".
- **Informational findings** (`INFO`: public-by-design keys, sample credentials in tests) are listed but cost nothing.
- **Filters** (`--category`, `--severity`) only narrow the findings that are displayed. Scores and `--min-score` always use the whole repository.
- **Default output** lists only findings worth acting on: HIGH or CERTAIN confidence, from a rule whose measured accuracy is at least 85% (once it has 10+ labels). HIGH/CRITICAL security findings at MEDIUM confidence are kept, because hiding a probable injection would make a vulnerable repository look clean. `--all` lists everything; `--audit` also lists findings in tests, examples, benchmarks and fixtures. Scores, `--min-score` and the hidden count are unaffected. `--fail-on` gates on the findings that are listed.
- A scan that analyzes zero JS/TS files prints a warning and always fails `--min-score`.

## Taint tracking

Security findings are not only pattern matches. DevKit follows request-controlled data (Express/Fastify `req.*`, Koa `ctx.*`, Hono `c.req.*()`, Next `request.json()`, NestJS `@Body()`/`@Query()`/`@Param()`/`@Headers()` parameters, and `process.argv`) through variables, destructuring, templates, concatenation and `path.join`, and across function calls (including other files) to the calls where it does damage:

| Sink | Rule |
| --- | --- |
| `exec`/`execSync` (child_process), `spawn(..., { shell: true })` | `SEC003` |
| `eval`, `new Function`, `vm.run*` | `SEC002` |
| `fs.*` and `res.sendFile/download` | `SEC009` |
| `query`/`execute`/`raw`/`$queryRawUnsafe` | `SEC008` |
| `fetch`, `axios`, `got`, `http(s).get` (the tainted part must choose the host) | `SEC013` |
| `res.redirect`, `c.redirect`, `NextResponse.redirect`, `Location` headers | `SEC012` |
| `new RegExp(x)` | `SEC014` |
| `target[a][b] = v` with a request key, lodash `merge`/`set`, `deepmerge` | `SEC011` |

A flow is stopped by a known cleaning step, and each step only counts for the sinks it protects: `parseInt`/`Number`, schema validation (`schema.parse`, zod), `path.basename` and `encodeURIComponent` (paths and URLs), SQL escapers, shell escapers, regex escapers, and checks that exit early: an allowlist (`LIST.includes(x)`), a format regex, `x.startsWith(root)` after `path.resolve`, `path.relative(root, x).startsWith('..')`, a `new URL(x).origin` comparison, or a relative-path test (`startsWith('/') && !startsWith('//')`). Where taint tracking shows a pattern-based finding is a false alarm because the value was cleaned, the pattern finding is dropped; where both agree, the finding becomes high confidence and names the flow.

Limits: it is function-level, not whole-program. A validator is trusted by name (`isAllowed(x)`, `validateX(x)`), so a flawed allowlist is not detected. A request value validated by an earlier lookup (`map.get(key)` returning null) is still reported, at lower confidence when fixed text surrounds it. NoSQL operators, template injection and XSS are not covered.

## Output formats

- **Terminal** (default) — live progress on stderr, then a boxed header, the score with letter grade and a progress bar, the three biggest score drains, and sectioned panels: scan coverage (files found, analyzed, secret-scanned, skipped, duration, detected project setup), per-category score bars, severity distribution, file hotspots, a code frame for the worst finding per category, and suggested next steps (hidden-finding counts and follow-up commands). Respects `NO_COLOR`/`FORCE_COLOR`; set `DEVKIT_ASCII=1` for plain-ASCII glyphs.
- **JSON** (`--json` / `--format json`) — the full `ScanSummary` object: score, category scores, every finding, repository metrics.
- **Markdown** (`--format markdown` / `devkit report`) — category table, biggest score drains, and a flat findings list, suitable for pasting into a PR description.
- **SARIF** (`--format sarif`) — standard SARIF 2.1.0, for GitHub code scanning and similar tools.

## Current limitations

- Framework entry-point detection covers package metadata, tests, and the Next.js, Docusaurus and NestJS conventions plus service workers. Other setups, such as a Vite `index.html` entry, may need entry files specified through package metadata or imports.
- Outside a git repository, `.gitignore` is approximated (negation patterns `!pattern` are skipped). `.devkitignore` never supports negation.
- Non-JS/TS files (Python, Go, YAML, ...) only get the secret scan, not code-quality rules. Script blocks in `.vue`/`.svelte` files are not parsed.
- `devkit fix --write` handles only unused imports, debug statements and `var`. Other findings are reported, not rewritten.
- `devkit baseline compare` compares the overall score only; it does not report newly added or resolved findings.
- The secret scan is scoped by `scan.exclude`, not `scan.include`: a secret outside your configured `include` globs is still reported, by design (security blind spots are worse than noise), but this is easy to miss if you expect `include` to fully sandbox a scan.
- DEP001/DEP002 are workspace-aware (each `package.json` in the repo is checked against its own files, with the root tolerated as a hoisting source) but do not read `pnpm-workspace.yaml` or Lerna config — only the `package.json` layout itself.
- The CLI-entry heuristic that discounts `console.*` findings looks for an import of a known argv-parsing library (commander, yargs, cac, meow, sade, clipanion). A hand-rolled CLI without one of these still gets flagged at full confidence.
- DevKit has no rule presets, React-specific or test-quality rules, configuration analysis, or incremental cache.

## CI/CD integration

```bash
devkit scan --min-score 7       # exit 1 if the overall score falls below 7
devkit scan --fail-on high      # exit 1 if any listed HIGH or CRITICAL finding exists
devkit scan --all               # include low-confidence findings and low-accuracy rules
devkit scan --audit             # --all, plus tests, examples and fixtures
devkit baseline compare          # compare against a previously stored baseline
```

## Development

```bash
npm run build     # tsc -p tsconfig.json
npm test          # vitest run
npm run dev        # tsx src/cli.ts (no build step)
```

Tests live in [`src/__tests__/`](src/__tests__), one file per rule category plus an end-to-end scan test (`e2e.test.ts`) and a scoring test. Each rule test typically builds a small in-memory `RuleContext` (see [`testUtils.ts`](src/__tests__/testUtils.ts)) and asserts on the findings a rule produces for known-good and known-bad snippets.

## Contributing

Contributions are welcome — new rules, bug fixes, false-positive reports, and documentation improvements. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup and the process for adding a rule. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security issue, see [SECURITY.md](SECURITY.md) rather than opening a public issue.

## License

[MIT](LICENSE) © Karan Chourasia
