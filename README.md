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
DevKit Repository Scan
/path/to/project

  7.8/10  Good
  [███████████████░░░░]

  Dead Code        8.4
  Dependencies     7.1
  Complexity       6.8
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

1. **Discovery** — walk the directory tree, apply configured include/exclude and ignore patterns, skip generated files, and select `.js`/`.jsx`/`.ts`/`.tsx`/`.mjs`/`.cjs` files.
2. **Parse** — build one `ts.Program` (via the TypeScript Compiler API) covering every discovered file, with `noUnusedLocals`/`noUnusedParameters`/`noImplicitAny` enabled so the compiler itself surfaces dead bindings and implicit `any`.
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
| [`src/suppressions.ts`](src/suppressions.ts) | Applies `devkit-disable-next-line` directives to findings. |
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
| Security | `SEC001`–`SEC010` (SEC006 reserved) | [`src/rules/security.ts`](src/rules/security.ts) |
| Architecture | `ARCH001` | [`src/rules/architecture.ts`](src/rules/architecture.ts) |
| Hygiene | `HYGIENE001`–`HYGIENE004` | [`src/rules/hygiene.ts`](src/rules/hygiene.ts) |

Run `devkit rules` for the live list, or `devkit explain <RULE_ID>` for a rule's full writeup (why it matters, example, fix classification).

> **Note:** `devkit-slop-scanner-final-prd.md` in the repo root is the original product-requirements document and describes a larger target surface (incremental caching, monorepo-aware scoring, rule presets, a V2 LLM layer, and more). The table above reflects what is currently implemented in `src/`; treat the PRD as the roadmap, not the current feature set. Minimal `devkit-disable-next-line` suppressions are implemented.

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
```

Run a full scan (defaults to colored terminal output):

```bash
devkit scan
devkit scan --json                     # machine-readable JSON (ScanSummary)
devkit scan --format markdown          # Markdown report
devkit scan --format sarif             # SARIF, for code-scanning platforms
devkit scan --category dead-code       # only one category
devkit scan --severity high            # only one severity level
```

Other commands:

```bash
devkit metrics            # repository metrics: LOC, function/class counts, largest files, etc.
devkit report              # full Markdown report (same as `scan --format markdown`)
devkit rules               # list every built-in rule (id, title, category)
devkit explain DEAD010     # full explanation of a single rule
devkit baseline create      # snapshot the current score to .devkit/baseline.json
devkit baseline compare     # compare current score against the stored baseline
devkit fix                  # preview findings marked as safe to fix
```

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

Each finding is weighted by `severity × confidence` ([`src/scoring.ts`](src/scoring.ts)) and normalized against source LOC (in 500-line chunks), so a single low-confidence finding in a large repository barely moves the score. Category scores are combined into the overall score using fixed weights:

| Category | Weight |
| --- | ---: |
| Dead code | 20% |
| Complexity | 15% |
| Dependencies | 10% |
| Duplication | 10% |
| Redundant logic | 10% |
| Error handling | 10% |
| Type safety | 10% |
| Architecture | 10% |
| Hygiene | 5% |

Security findings are scored and reported separately rather than folded into the overall score.

## Output formats

- **Terminal** (default) — colored, with a score bar, per-category breakdown, and code frames for the top finding per category.
- **JSON** (`--json` / `--format json`) — the full `ScanSummary` object: score, category scores, every finding, repository metrics.
- **Markdown** (`--format markdown` / `devkit report`) — category table, top deductions, and a flat findings list, suitable for pasting into a PR description.
- **SARIF** (`--format sarif`) — standard SARIF 2.1.0, for GitHub code scanning and similar tools.

## Current limitations

- Framework entry-point detection is limited to package metadata, tests, and a basic Next.js convention check. Other React setups such as Vite may need entry files specified through package metadata or imports.
- `.gitignore` and `.devkitignore` negation patterns (`!pattern`) are skipped; full Git ignore semantics are not implemented.
- `devkit fix` only previews findings marked as safe. It does not modify files.
- `devkit baseline compare` compares the overall score only; it does not report newly added or resolved findings.
- DevKit has no rule presets, React-specific or test-quality rules, configuration analysis, incremental cache, or monorepo-aware scoring.

## CI/CD integration

```bash
devkit scan --min-score 7       # exit 1 if the overall score falls below 7
devkit scan --fail-on high      # exit 1 if any HIGH or CRITICAL finding exists
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
