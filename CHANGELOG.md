# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Benchmark harness** (`bench/`, part of #8): a measurable accuracy baseline
  that later rule changes are judged against.
  - `bench/seeded/` is a small repo with 20 planted security/quality issues and
    9 known-clean decoys, each tagged with the rule expected to catch (or leave
    alone) the code. Three planted issues (G1, G2, G6) and one decoy (R2) are
    recorded as known gaps rather than hidden.
  - `npm run bench` reports the planted-issue catch rate and per-rule accuracy
    (Markdown to stdout; `--json <file>` for structured output).
  - `npm run bench:check` is the CI gate: it fails when a planted issue is
    missed or any rule's accuracy drops more than 2 points below
    `bench/baseline.json`.
  - `bench/corpus.json` pins zod, hono, trpc, excalidraw, nest and date-fns to
    fixed commits; `npm run bench:corpus` clones and scans them, and
    `npm run bench:sample` draws a reproducible sample of findings to label by
    hand into `bench/labels/*.jsonl`.

### Fixed

False-positive reduction, validated by scanning 11 open-source repositories
(JS and TS libraries, a Node API, Next.js apps, two monorepos). Findings on
the original six repositories fell from 59,306 to about 2,100; a second set of
five repositories was then scanned, its false-positive classes were triaged by
hand, and the rules were adjusted again.

- **Performance:** workspaces with hundreds of packages no longer take minutes
  to scan (per-package file ownership was recomputed quadratically).
- **TypeScript strictness** follows the project's own `tsconfig.json`
  (including nested package configs and `paths` aliases) instead of a fixed
  strict mode: no implicit-any findings in plain JavaScript or when the project
  turned `noImplicitAny` off.
- **Tests, examples, benchmarks, fixtures and scaffolds** are no longer judged
  by style/typing/complexity/duplication/dead-code rules or by injection,
  crypto and TLS security rules. The hidden count appears in scan coverage;
  `scan.includeNonProduction` restores them. Secret detection still runs
  everywhere, with fixture data discounted.
- **SEC001:** `.example`/`.sample`/`.template` files, public demo/anon JWTs,
  `env(NAME)` references, credential-less URLs and file paths are no longer
  reported as secrets.
- **SEC003:** only `child_process` execution is reported (resolved through the
  type checker, including aliases and namespace imports), not `regex.exec()`.
- **SEC004:** literal HTML assignments are ignored; `JSON.stringify` payloads
  are downgraded.
- **ERR003/ERR004/REDUNDANT001:** real Promises are distinguished from
  single-callback thenables, self-handling async IIFEs, helpers that return
  their argument and fluent builders; `.then(a, b)` counts as handled;
  `=== false` on an untyped value is not called redundant.
- **DEP001:** usage is now found in tool config files, data configs
  (`nx.json`, `.eslintrc.json`, ...), stylesheets, package.json tool fields,
  string-loaded packages, executables named differently from their package,
  tool shorthand names (`next/core-web-vitals` → `eslint-config-next`),
  compiler options (`importHelpers`) and peer dependencies (from
  `node_modules`, `package-lock.json` or `pnpm-lock.yaml`). Confidence reflects
  how verifiable the claim is, and only HIGH-confidence findings appear in
  `devkit fix`; plugins/presets/parsers are never auto-fixable.
- **DEP002:** `node:`/`bun:`/`jsr:` specifiers, path aliases, import maps,
  `@types/*`-typed imports, self and workspace names, and example code are not
  reported as unlisted dependencies.
- **DEP003:** type-only imports are ignored and each tangled group of files is
  reported once instead of once per path.
- **DEAD002/DEAD003/DEAD006:** the exact unused specifier is reported;
  positional parameters before a used one and `_`-prefixed names are kept;
  state variables whose setter is still used are not offered as safe fixes.
- **DEAD009/DEAD010:** entry points are resolved per package (monorepos),
  from `main`/`exports`/`browser`/`module`/`bin`, mapped from build output back
  to source, from files referenced in config/CI/Dockerfiles and non-script
  package.json fields, and from Next.js conventions under `src/` and the root.
  `export * as ns from` is no longer dropped from the module graph.
- **DUP001:** type-level syntax (overloads, generic parameter lists,
  interfaces) is ignored, the minimum window is larger, and a block repeated
  across many files is reported once.
- **COMPLEX001, JS001, TS001/TS002, HYGIENE001:** flat switch-style functions
  no longer score HIGH; `var`-style codebases are not nagged per declaration;
  `any` in type arguments is LOW; explained `@ts-expect-error` is accepted;
  files with a shebang are treated as CLIs.

### Changed

- `devkit fix` previews only findings that are both fixable and HIGH/CERTAIN
  confidence.
- New config option `scan.includeNonProduction`.

## [0.1.1] - 2026-10-02

**Heads up if you ran `devkit scan` on 0.1.0:** file discovery silently
skipped a meaningful share of most repositories (any `build`/`out`/`vendor`/
`dist`/`coverage`-named folder anywhere in the tree, any file with a "do not
edit" comment anywhere in it, and anything outside a correctly-anchored
`.gitignore` pattern), and the secret scanner only ever looked at `.js`/`.ts`
files. A clean-looking score or a "no findings" security result from 0.1.0
may reflect files that were never actually scanned, including `.env`, YAML,
and JSON config files that can hold real credentials. Re-run `devkit scan` on
0.1.1 before trusting a prior result.

### Fixed

- Discovery no longer silently skips source files: folders named `build`,
  `out`, `dist`, or `coverage` are only skipped when they are build output in
  a package root (a `src/build/` or `src/commands/out/` is scanned normally);
  `vendor/` is never auto-skipped, since vendored/checked-in code is still
  real, committed content; root-anchored `.gitignore` patterns (`/lib`) stay
  anchored instead of matching at every depth; a "do not edit" note is only
  treated as a generated-file marker when it appears in the file's leading
  comment block, not anywhere in the file; `**/x` globs no longer false-match
  `myx`. Discovery now uses `git ls-files` when available, so `.gitignore` is
  applied with exact git semantics.
- Secret scanning now covers every text file (`.env`, YAML, JSON,
  Dockerfiles, other languages), not only JS/TS. A `.gitignore`d `.env` is no
  longer reported as committed.
- Dependency rules (`DEP001`/`DEP002`) are now workspace-aware: every
  `package.json` in the repo is checked against its own files, with the
  workspace root tolerated as a hoisting source. Previously, every
  correctly-declared dependency in a non-root workspace/monorepo package was
  flagged as "unlisted."
- Scoring: security findings are now part of the overall score and cap it at
  6.9 on a credible (high-confidence, non-test) finding, instead of being
  computed and then discarded; architecture is only scored when
  `architecture.layers` is configured, instead of granting free points;
  findings inside test files count at half weight; a scan that analyzes zero
  source files now always fails `--min-score` instead of scoring 10.
- CLI: `--category` accepts `dead-code`-style names (previously only the
  internal camelCase form matched, so the documented examples didn't work);
  filtering findings with `--category`/`--severity` no longer recomputes a
  fake score for the filtered subset; invalid `--min-score`, `--fail-on`, and
  `--format` values are now rejected instead of silently passing.
- Duplication detection no longer flags shared `import` headers between
  files, or overlapping windows within the same file, as copy-pasted code.
- An empty catch block with an explanatory comment is no longer flagged by
  `ERR001`, matching the rule's own suggested fix.
- Fixed the published CLI command name (`devkit`) to match the `bin` entry in
  `package.json`.

### Added

- Every scanning command (`scan`, `report`, `metrics`, `fix`,
  `baseline create`/`compare`) now accepts an optional `[path]` argument to
  scan a directory other than the current one.
- A `devkit-disable-file` suppression directive, alongside the existing
  `devkit-disable-next-line`, for silencing specific rules (or all rules)
  across a whole file.
- Scan coverage is now reported: files found vs. analyzed vs. secret-scanned,
  generated/oversized/binary files skipped, and scan duration.

### Changed

- Terminal output redesigned: live progress bar during the scan (previously a
  spinner that never animated, since the scan is synchronous), a letter
  grade, a scan-coverage section, per-category score bars, a severity
  distribution bar, a file "hotspots" list, and restyled issue cards.
- `console.*` findings (`HYGIENE001`) in a file that imports a CLI
  argument-parsing library (commander, yargs, cac, meow, sade, clipanion) are
  now reported at LOW confidence instead of CERTAIN, since that output is
  usually the program's actual product, not a debug leftover. Still
  reported, not suppressed.
- Open-sourced the project: contributing guide, code of conduct, security
  policy, issue/PR templates, and CI.

## [0.1.0]

- Initial release: deterministic scan pipeline (discovery, TypeScript
  Compiler API parse, module graph, rules, scoring, reporting).
- Rule categories: dead code, dependencies, complexity, duplication, error
  handling, redundant logic, TypeScript safety, JavaScript hygiene, security,
  architecture, repository hygiene.
- Terminal, JSON, Markdown, and SARIF output formats.
- `devkit init`, `scan`, `report`, `metrics`, `rules`, `explain`, `baseline`,
  and `fix` commands.
