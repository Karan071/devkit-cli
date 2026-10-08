# DevKit

[![CI](https://github.com/Karan071/devkit-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Karan071/devkit-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/devkit-quality.svg)](https://www.npmjs.com/package/devkit-quality)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

DevKit is a deterministic, offline code-quality scanner for JavaScript and TypeScript repositories. It walks a project, parses every source file with the TypeScript compiler, and reports a 0-10 "code quality" score backed by concrete, file-and-line findings — dead code, unused dependencies, excessive complexity, duplication, unsafe error handling, unsafe TypeScript, security anti-patterns, architecture violations, and repository hygiene issues.

It does not call an LLM, an API, or the network. Every finding is reproducible from the source tree alone.

What it does beyond pattern matching:

- **Follows request data to dangerous calls** (taint tracking): Express/Koa/Hono/Next/NestJS inputs and `process.argv` are traced through variables and across functions and files to command execution, `eval`, file paths, SQL, `fetch`, redirects, `RegExp` and prototype pollution — and stopped by known cleaning steps. See [Taint tracking](#taint-tracking).
- **Measures its own accuracy** against a seeded repository and a pinned corpus of real projects, and gates CI on it. See [Benchmark and accuracy](#benchmark-and-accuracy).
- **Shows you what is worth acting on.** The default output lists confident findings from accurate rules, says how many it hid, and names the three rules costing the most points. See [Terminal interface](#terminal-interface).
- **Fits a pull-request workflow:** `scan --since <ref>`, `fix --write`, SARIF with stable fingerprints, `doctor`, and optional `gitleaks`/`knip` merging.

> Version note: the commands marked **0.2.0** below (`doctor`, `fix --write`, `scan --since`, `scan --with`, `--all`, `--audit`, `init --interactive`) need DevKit 0.2.0 or later. Run `devkit --version` to check.

```bash
npx devkit-quality scan
```

```text
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
- [Terminal interface](#terminal-interface)
- [Configuration](#configuration)
- [Scoring model](#scoring-model)
- [Taint tracking](#taint-tracking)
- [Benchmark and accuracy](#benchmark-and-accuracy)
- [Output formats](#output-formats)
- [Current limitations](#current-limitations)
- [CI/CD integration](#cicd-integration)
- [Development](#development)
- [Releases](#releases)
- [Contributing](#contributing)
- [License](#license)

## How it works

A scan runs in a single pass over the repository:

1. **Discovery** — list files with `git ls-files` (exact `.gitignore` semantics; falls back to a filesystem walk outside git), apply include/exclude and `.devkitignore`, skip generated/minified files (detected by name, header comments, very long lines and Emscripten glue) and build output in package roots, and split files into JS/TS sources (`.js`/`.jsx`/`.ts`/`.tsx`/`.mjs`/`.cjs`/`.mts`/`.cts`, fully analyzed) and other text files (configs, `.env`, YAML, Markdown/MDX, other languages — secret-scanned, and read for references). Every file is classified as production, test, example, benchmark, script, fixture or vendored code.
2. **Parse & type-check** — build one `ts.Program` (via the TypeScript Compiler API) covering every discovered file, using your own `tsconfig.json` for strictness. The compiler itself surfaces dead bindings and implicit `any`.
3. **Module graph** — resolve imports, `require()`, `require.resolve()`, dynamic `import()`, TypeScript path aliases, bundler aliases, workspace package names and re-exports into an internal dependency graph (edges, entry points, barrels, re-export targets). Entry points come from `package.json` (`main`, `exports` including wildcards, `bin`), framework conventions, config files, CI, MDX imports and runtime-built file paths.
4. **Environment check** — record whether dependencies are installed, which tsconfigs apply, workspaces, frameworks and unresolved imports. If packages cannot be resolved, type-based findings (`TS001`, `ERR003`) are downgraded to low confidence and the report says so.
5. **Rules** — each rule module receives a shared `RuleContext` (files, program, module graph, config, `package.json`) and returns `Finding[]`. The security rules combine pattern checks with [taint tracking](#taint-tracking); a pattern finding the taint analysis proves was cleaned is dropped.
6. **Optional tools** — with `--with`, `gitleaks` and `knip` run and their findings join the list.
7. **Scoring** — production-code findings are weighted by severity × confidence, normalized against repository size, capped per rule, and rolled up into per-category and overall scores. The three biggest score drains are recorded.
8. **Reporting** — the same `ScanSummary` is filtered to the findings worth acting on and rendered as colored terminal output, JSON, Markdown, or SARIF.

Design principle carried over from the project's PRD (`devkit-slop-scanner-final-prd.md`): never use an LLM to answer a question static analysis can answer deterministically. DevKit only measures *observable* characteristics of the code (unused, duplicated, overly complex, unsafe) — it makes no claim about authorship or subjective quality.

## Architecture

```text
                 devkit scan
                      |
                      v
              scanRepository()               scanner.ts
                      |
        +-------------+--------------+----------------+
        |             |              |                |
   walkDirectory  createProgram   buildModuleGraph   describeEnvironment
   (discovery.ts) (ast/parse.ts)  (moduleGraph.ts)   (environment.ts,
        |             |              |                typeAwareness.ts)
        +-------------+--------------+----------------+
                      |
                      v
                 RuleContext                  context.ts
                      |
        +----+----+----+----+----+----+----+----+----+----+
        |    |    |    |    |    |    |    |    |    |    |
     deadCode|complexity|duplication|errorHandling|redundancy
        dependencies   typescript  javascript  architecture
                 hygiene        security
                              (patterns + secrets.ts + taint.ts)
                 (src/rules/*.ts, definitions in rules.ts)
        +----+----+----+----+----+----+----+----+----+----+
                      |
                      +---- runAdapters()  gitleaks / knip   (--with)
                      |                    adapters.ts
                      v
                  Finding[]                   finding.ts / types.ts
                      |
                      v
                computeScores()               scoring.ts
                      |
                      v
                 ScanSummary
                      |
                      v
         shown-by-default filter, --since     ruleQuality.ts, since.ts
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
| [`src/finding.ts`](src/finding.ts) | `buildFinding()` constructs a `Finding` whose id is a fingerprint of rule, file and normalized code (not the line number), so ids survive refactors. |
| [`src/scoring.ts`](src/scoring.ts) | Converts production-code findings into category scores, an overall 0-10 score and the biggest score drains. |
| [`src/reporters.ts`](src/reporters.ts) | Terminal, JSON, Markdown, and SARIF renderers, the `doctor` report, and baseline-compare output. |
| [`src/terminal.ts`](src/terminal.ts) | ANSI color helpers, score bar, code-frame rendering, spinner. |
| [`src/glob.ts`](src/glob.ts) | Minimal glob-to-regex matcher used for config include/exclude patterns. |
| [`src/fileKind.ts`](src/fileKind.ts) | Classifies each file (production, test, type-test, example, benchmark, script, fixture) and declares which kinds each rule applies to. |
| [`src/dependencyUsage.ts`](src/dependencyUsage.ts) | Finds dependency usage that no import shows: config files, stylesheets, tool shorthand names, executables, peers (from `node_modules` or lockfiles). |
| [`src/frameworkConventions.ts`](src/frameworkConventions.ts) | Files a framework loads by convention (Next.js, Docusaurus, NestJS, service workers) and the virtual modules a framework resolves itself (Docusaurus, SvelteKit). |
| [`src/workspaceResolution.ts`](src/workspaceResolution.ts) | Resolves workspace package names (`@scope/pkg/sub.js`) and Docusaurus `@site/...` imports to source files without `node_modules` links; maps build output back to source. |
| [`src/bundlerAliases.ts`](src/bundlerAliases.ts) | Reads import aliases from Vite/webpack/Rollup/Jest/Babel configs so they are not reported as unlisted dependencies. |
| [`src/mdxImports.ts`](src/mdxImports.ts) | Parses `import` lines from `.md`/`.mdx` documents, ignoring code fences. |
| [`src/typeAwareness.ts`](src/typeAwareness.ts) | Decides whether the type checker could see the project's dependencies, and downgrades type-based findings if not. |
| [`src/environment.ts`](src/environment.ts) | Gathers the project facts shown by `devkit doctor` and the "Project" line (dependencies, tsconfig, workspaces, frameworks, entry points). |
| [`src/ruleQuality.ts`](src/ruleQuality.ts) | Decides which findings are shown by default from confidence and each rule's measured accuracy (the table is generated by `npm run bench:report`). |
| [`src/since.ts`](src/since.ts) | Parses `git diff` and keeps findings on changed lines for `scan --since`. |
| [`src/fixes.ts`](src/fixes.ts) | Plans and verifies the safe fixes behind `devkit fix` / `fix --write`. |
| [`src/initInteractive.ts`](src/initInteractive.ts) | Proposes ignores and writes `.devkitrc.json` for `init --interactive`. |
| [`src/adapters.ts`](src/adapters.ts) | Runs `gitleaks` and `knip` for `scan --with` and maps their output to findings. |
| [`src/rules/secrets.ts`](src/rules/secrets.ts), [`secretPatterns.ts`](src/rules/secretPatterns.ts) | Secret detection (`SEC001`): provider token formats, GitHub checksum validation, credential-like names in string literals and config values. |
| [`src/rules/taint.ts`](src/rules/taint.ts) | Taint tracking from request inputs to dangerous calls (`SEC002`, `SEC003`, `SEC008`, `SEC009`, `SEC011`–`SEC014`). |
| [`src/rules/securityHelpers.ts`](src/rules/securityHelpers.ts) | Call-site checks shared by the pattern rules and the taint analysis (is this `exec` really `child_process`?). |
| [`src/version.ts`](src/version.ts) | Reads the package version for `devkit --version`. |
| [`bench/`](bench) | The accuracy benchmark: seeded repo, pinned corpus, labels, scorer. See [Benchmark and accuracy](#benchmark-and-accuracy). |

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

```text
cli-tool/
├── bin/devkit.js          # Shebang entry point, requires dist/cli.js
├── src/
│   ├── cli.ts             # Command definitions (scan, report, metrics, rules, explain, baseline, fix, init, doctor)
│   ├── scanner.ts         # scanRepository() — the main pipeline
│   ├── discovery.ts       # File walking/filtering
│   ├── moduleGraph.ts     # Import/export graph, entry points, cycle detection
│   ├── config.ts          # .devkitrc.json loading
│   ├── context.ts         # RuleContext type
│   ├── rules.ts           # Rule metadata catalog
│   ├── rules/             # One file per rule category (the detectors), plus secrets and taint
│   ├── ast/               # TypeScript Compiler API helpers
│   ├── finding.ts         # Finding constructor and stable ids
│   ├── scoring.ts         # Score computation
│   ├── ruleQuality.ts     # Which findings are shown by default
│   ├── reporters.ts       # terminal/json/markdown/sarif output
│   ├── terminal.ts        # Color/formatting primitives (the terminal interface)
│   ├── fixes.ts, since.ts, adapters.ts, initInteractive.ts, environment.ts, ...
│   └── __tests__/         # Vitest suite, one file per rule category + e2e
├── bench/                 # Accuracy benchmark: seeded repo, corpus, labels, scorer, ACCURACY.md
├── dist/                  # Compiled output (tsc), what bin/devkit.js actually runs
├── tsconfig.json
└── package.json
```

## Setup

Requires Node.js `^22.12.0 || ^24.0.0 || >=26.0.0` (the version range the test suite's dependencies require; Node 18 and 20 are not supported).

To scan a project without installing anything, run `npx devkit-quality scan` from its root (see [INSTALL.md](INSTALL.md) for linking a local checkout, CI use and troubleshooting). Install the project's own dependencies first (`npm install`, `pnpm install`, ...): without `node_modules`, type information is missing and type-based findings are reported at low confidence. `devkit doctor` tells you whether that is the case.

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
devkit scan --all                      # include low-confidence findings and low-accuracy rules (see "Scoring model")
devkit scan --audit                    # --all, plus findings in tests, examples, benchmarks and fixtures
devkit scan --min-score 7 --fail-on high   # quality gates for CI (exit code 1 when not met)
```

Other commands:

```bash
devkit metrics            # repository metrics: LOC, function/class counts, largest files, etc.
devkit report              # full Markdown report (same as `scan --format markdown`)
devkit rules               # list every built-in rule (id, title, category)
devkit explain DEAD010     # full explanation of a single rule (try SEC013 for the new taint rules)
devkit baseline create      # snapshot the current score to .devkit/baseline.json
devkit baseline compare     # compare current score against the stored baseline
devkit fix                  # preview the safe fixes
devkit fix --write          # apply them: unused imports, console.log/debug, var -> let/const
devkit doctor               # are dependencies installed? which tsconfig, workspaces, frameworks, entry points?
```

`devkit fix --write` is conservative. It removes exactly the import bindings the compiler reports as unused, deletes `console.log`/`console.debug`/`debugger` statements that are not the only statement in their block, and turns a top-level `var` into `const`/`let` only when it is declared once, never used before its declaration or from a hoisted function, and lives in a module. Every changed file is re-checked, and left untouched if a fix would add a compile error. Review the diff and run your tests afterwards.

`devkit scan --since <ref>` lists only the findings on lines that changed since a git ref (a branch, tag or commit); files git has not seen yet count in full. The score and `--min-score` still cover the whole repository, so a pull-request check can show just what the PR introduced while the gate stays honest. A bad ref fails immediately, before the scan.

`devkit doctor` prints what decides how far the findings can be trusted: whether dependencies are installed (and the install command for your package manager), the root `tsconfig.json` and nested ones, packages and workspace globs, detected frameworks, the number of entry points, and how many imports could not be resolved. The same facts appear as the "Project" line in every scan.

`--with` runs `gitleaks` and `knip` if they are on the `PATH` or in `node_modules/.bin`, and merges their findings (rule ids `GITLEAKS:*` and `KNIP:*`) into the score and the SARIF output. A tool that is missing or prints something unreadable is reported as a warning; the built-in scan still completes. Matched secret text from gitleaks is never copied into a finding.

### Silencing a finding

Add a comment, with an optional list of rule IDs (without IDs, every rule is silenced):

```ts
// devkit-disable-next-line SEC009
fs.readFileSync(path.join(root, name));

// devkit-disable-file DUP001, COMPLEX001
```

`devkit-disable-next-line` covers the following line; `devkit-disable-file` anywhere in a file covers that whole file.

## Terminal interface

DevKit's interface is the terminal report. (There is no separate graphical or web application.) It is laid out so the answer comes first and the evidence follows, in this order:

| Panel | What it shows |
| --- | --- |
| **Header box** | The tool name and the scanned path (your home directory shown as `~`). |
| **Score** | `8.5 / 10`, a letter grade and label, and a score bar. If a serious security finding capped the score, a `▲ Capped at 6.9` line says so. |
| **Biggest score drains** | The three rules that cost the most points and each one's cost (for example `-0.49`), with the finding count. Fix these first. |
| **Scan coverage** | Duration, how files were found (git or filesystem walk), files found / analyzed as JS/TS / secret-scanned, lines of code (source and test), what was skipped (generated files, oversized files, test/example findings hidden), file types, and the **Project** line from `devkit doctor`. Warnings, such as "dependencies are not installed", appear here in yellow. |
| **Categories** | One bar per category (Dead Code, Dependencies, Complexity, …) with its score and either `✔ clean` or the number of findings. Architecture shows `n/a` until you configure layers. |
| **Findings** | A stacked severity bar and counts (`● 35 high ● 80 medium ● 23 low`). |
| **Hotspots** | The files that cost the most points, with their worst severity. |
| **Top issues** | The worst finding in each category, with the rule, the explanation, the suggested fix, and a code frame that points at the exact line. |
| **Next steps** | How many findings were not shown, how many lower-confidence findings were hidden by default (and the flags that reveal them), and the commands to explore further. |

```text
── NEXT STEPS ─────────────────────────────────────────
  135 more findings not shown above.
  101 lower-confidence findings hidden. Run with --all to list them (--audit also includes tests and examples)
  devkit scan --category <name>   focus on one category (e.g. security, dead-code)
  devkit scan --format markdown   full report with every finding
  devkit explain <RULE_ID>        why a rule exists and how to fix it
  devkit fix                      preview findings marked safe to fix
```

Behavior worth knowing:

- **Colors and glyphs.** Color is on when stdout is a terminal. Set `NO_COLOR=1` to turn it off, or `FORCE_COLOR=1` to keep it when piping. Set `DEVKIT_ASCII=1` (or use `TERM=dumb`) for plain-ASCII glyphs if your terminal does not render the box and bar characters.
- **Width.** The layout adapts to the terminal width, clamped between 60 and 100 columns.
- **Progress.** A live progress bar with the current phase is drawn on **stderr** while scanning, and only when stderr is a terminal. Piped and CI output stays clean, so `devkit scan --json > report.json` captures only the report.
- **`INFO` findings** (public-by-design keys, sample credentials in tests) are marked informational and cost no points.
- **Confidence.** Each finding carries a severity and a confidence. The default view shows confident findings from accurate rules; `--all` and `--audit` widen it.

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

## Benchmark and accuracy

A scanner that is not measured cannot tell whether a new rule helps or hurts, so DevKit ships with a benchmark ([`bench/`](bench)):

- **A seeded repository** ([`bench/seeded`](bench/seeded)) with 40 planted issues (secrets, injection, TLS-off, cycles, orphan files, request-to-sink flows, …) and 23 known-clean decoys (a comment that mentions a token, a parameterized query, a value passed through `parseInt`, …). Each is mapped to the rule that must catch it, or leave it alone.
- **A pinned corpus** of seven real projects at fixed commits — zod, hono, trpc, excalidraw, nest, date-fns and OWASP Juice Shop (a deliberately vulnerable app, used as ground truth for injection findings) — and **hand-assigned labels** (real / false positive, with a reason) for sampled findings in [`bench/labels/`](bench/labels).
- **A scorer** that reports the planted-issue catch rate and the per-rule accuracy (the share of labeled findings that were real).

```bash
npm run bench              # catch rate and per-rule accuracy for the seeded repo (and corpus, if present)
npm run bench:check        # the CI gate: fails if a planted issue is missed or a rule loses more than 2 accuracy points
npm run bench:corpus       # clone the pinned corpus and scan it (about four minutes)
npm run bench:sample -- 30 # draw a reproducible sample of findings to label by hand
npm run bench:report       # regenerate bench/ACCURACY.md and the measured accuracy used by the default output
```

The per-rule table is [`bench/ACCURACY.md`](bench/ACCURACY.md); how the benchmark works and how to add a case is in [`bench/README.md`](bench/README.md). Treat the numbers as an early measurement: most rules have fewer than the 30 labels needed for a reliable percentage and the table marks them "(low)". The measured accuracy feeds the default output: a rule below 85% accuracy (with at least 10 labels) is hidden unless you pass `--all`.

## Output formats

- **Terminal** (default) — the [terminal interface](#terminal-interface) above.
- **JSON** (`--json` / `--format json`) — the full `ScanSummary` object: `score`, `categoryScores`, `securityScore`, every `finding` (with a stable `id`), `metrics`, `coverage` (including `warnings` and `nonProductionFindingsUnscored`), `scoreDrains` (the top three rules by points lost), `environment` (what `devkit doctor` reports), and `hiddenByDefault` (how many findings the default view left out).
- **Markdown** (`--format markdown` / `devkit report`) — category table, biggest score drains, the project line and warnings, and a flat findings list, suitable for pasting into a PR description.
- **SARIF** (`--format sarif`) — standard SARIF 2.1.0 for GitHub code scanning and similar tools. Every result carries a `partialFingerprints` entry built from the stable finding id, so alerts are not closed and reopened when lines shift, and `--with` tools appear as their own rules.

The default listing applies to every format; add `--all` or `--audit` to include everything.

## Current limitations

- Framework entry-point detection covers package metadata, tests, and the Next.js, Docusaurus and NestJS conventions plus service workers. Other setups, such as a Vite `index.html` entry, may need entry files specified through package metadata or imports.
- Outside a git repository, `.gitignore` is approximated (negation patterns `!pattern` are skipped). `.devkitignore` never supports negation.
- Non-JS/TS files (Python, Go, YAML, ...) only get the secret scan, not code-quality rules. Script blocks in `.vue`/`.svelte` files are not parsed.
- `devkit fix --write` handles only unused imports, debug statements and `var`. Other findings are reported, not rewritten.
- `devkit baseline compare` compares the overall score only; it does not report newly added or resolved findings.
- The secret scan is scoped by `scan.exclude`, not `scan.include`: a secret outside your configured `include` globs is still reported, by design (security blind spots are worse than noise), but this is easy to miss if you expect `include` to fully sandbox a scan.
- DEP001/DEP002 are workspace-aware (each `package.json` in the repo is checked against its own files, with the root tolerated as a hoisting source) but do not read `pnpm-workspace.yaml` or Lerna config — only the `package.json` layout itself.
- The CLI-entry heuristic that discounts `console.*` findings looks for an import of a known argv-parsing library (commander, yargs, cac, meow, sade, clipanion). A hand-rolled CLI without one of these still gets flagged at full confidence.
- Without installed dependencies, type-based findings (`TS001`, `ERR003`) are reported at low confidence. Install first, or read the warning in the report.
- Taint tracking is function-level and trusts validators by name; see [Taint tracking](#taint-tracking) for what it does not cover.
- `--with gitleaks,knip` was tested against stand-in executables shaped like those tools' documented JSON output, not against the real tools.
- Large repositories can be slow: date-fns takes about two minutes to scan.
- DevKit has no rule presets, React-specific or test-quality rules, configuration analysis, or incremental cache.

## CI/CD integration

```bash
devkit scan --min-score 7       # exit 1 if the overall score falls below 7
devkit scan --fail-on high      # exit 1 if any listed HIGH or CRITICAL finding exists
devkit scan --all               # include low-confidence findings and low-accuracy rules
devkit scan --audit             # --all, plus tests, examples and fixtures
devkit baseline compare          # compare against a previously stored baseline
```

`--min-score` always uses the whole repository, while `--fail-on` gates on the findings that are listed. Combined with `--since`, a pull-request check can fail only on what the PR introduced.

A GitHub Actions workflow that fails a pull request on new high-severity findings, enforces a minimum overall score, and uploads results to code scanning:

```yaml
name: DevKit
on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  security-events: write   # needed to upload SARIF

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # --since needs the base branch's history
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci        # install dependencies so type-based findings are reliable
      - name: Fail on new high-severity findings
        run: npx devkit-quality scan --since origin/${{ github.base_ref }} --fail-on high
      - name: Enforce the overall score
        run: npx devkit-quality scan --min-score 7
      - name: Upload SARIF
        if: always()
        run: npx devkit-quality scan --format sarif > devkit.sarif
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: devkit.sarif
```

Notes: the first scan step looks only at lines the PR changed; the second step is the repository-wide gate. Pin `devkit-quality` to a version in your own CI (`npx devkit-quality@0.2.0 …`, once 0.2.0 is published on npm; check with `npm view devkit-quality version`) so a new release cannot change your gate. Run `devkit doctor` in the job log when debugging a surprising result.

## Development

```bash
npm run build     # tsc -p tsconfig.json
npm test          # vitest run
npm run dev        # tsx src/cli.ts (no build step)
npm run bench:check      # the accuracy gate CI runs (seeded repo)
npm run bench:typecheck  # type-check the benchmark scripts
```

Tests live in [`src/__tests__/`](src/__tests__) (and the benchmark's in [`bench/__tests__/`](bench/__tests__)), one file per rule category plus an end-to-end scan test (`e2e.test.ts`), a scoring test, and files for taint tracking, the CLI features and the adapters. Each rule test typically builds a small in-memory `RuleContext` (see [`testUtils.ts`](src/__tests__/testUtils.ts)) and asserts on the findings a rule produces for known-good and known-bad snippets.

## Releases

Version history, with upgrade notes for behavior changes, is in [CHANGELOG.md](CHANGELOG.md); releases are published on the [GitHub releases page](https://github.com/Karan071/devkit-cli/releases). Before tagging a release, `npm run bench:report` regenerates the accuracy table (see [CONTRIBUTING.md](CONTRIBUTING.md#releasing)).

## Contributing

Contributions are welcome — new rules, bug fixes, false-positive reports, and documentation improvements. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup and the process for adding a rule. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security issue, see [SECURITY.md](SECURITY.md) rather than opening a public issue.

## License

[MIT](LICENSE) © Karan Chourasia
