# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- `tsconfig.json` uses `module`/`moduleResolution` `Node16` and declares
  `types: ["node"]`. The old `moduleResolution: "Node"` is deprecated and an
  error in TypeScript 6 and later, and newer compilers no longer pick up
  `@types/node` on their own, so editors and a future TypeScript upgrade
  reported errors in `tsconfig.json` and `bench/tsconfig.json`. The compiled
  output is unchanged (the package is CommonJS).

## [0.2.0] - 2026-10-08

DevKit now measures its own accuracy, finds injection flaws by following request
data, reports far fewer false positives, and gains commands for pull-request
workflows. Measured on seven real repositories (zod, hono, trpc, excalidraw,
nest, date-fns and OWASP Juice Shop), findings fell from 13,640 to 9,428.

### Upgrade notes

Behavior changes to be aware of when moving from 0.1.1:

- **The terminal, Markdown and JSON output now list fewer findings by default.**
  Only `HIGH`/`CERTAIN`-confidence findings from rules at 85% measured accuracy
  or better are listed (`HIGH`/`CRITICAL` security findings stay visible at
  `MEDIUM` confidence). Run `devkit scan --all` for everything, or `--audit` to
  include tests, examples and fixtures too. The scan says how many findings were
  hidden. `--fail-on` gates on the findings that are listed; `--min-score` still
  uses the whole repository.
- **Scores will move.** The headline and category scores now count production
  code only, and a single rule's cost to a category grows logarithmically past
  2 points. Repositories with a large test suite can score lower (zod went from
  8.8 to 8.5, because its density is no longer diluted by 51k lines of tests);
  repositories dominated by one noisy rule score higher. Re-create any stored
  baseline (`devkit baseline create`).
- **Finding ids changed.** `Finding.id` is now a fingerprint of rule, file and
  normalized code, not `rule-file-line-column`. Anything keyed on the old ids
  needs regenerating.
- **A new `INFO` severity is in use.** Public-by-design keys and sample
  credentials in tests and docs are reported as `INFO`. They are shown, but they
  cost no points.
- **`TS001` and `ERR003` are reported at `LOW` confidence when dependencies are
  not installed**, with a warning. Run your package manager's install first for
  accurate type-based findings.
- **`devkit fix` previews a different plan** and, with `--write`, edits files.
  It does nothing to your files without `--write`.
- **JSON output gained fields:** `scoreDrains`, `environment`, `hiddenByDefault`,
  `coverage.warnings` and `coverage.nonProductionFindingsUnscored`.
- Four new rules (`SEC011`–`SEC014`) can add findings to a repository that was
  clean before.

### Added

- **Taint tracking.** Request inputs (Express `req.*`, Koa `ctx.*`, Hono
  `c.req.*()`, Next `request.json()`, NestJS `@Body`/`@Query`/`@Param`/`@Headers`
  parameters, and `process.argv`) are followed through variables, destructuring,
  templates, concatenation and `path.join`, and across functions and files, to
  command execution (`SEC003`), `eval` (`SEC002`), filesystem paths (`SEC009`),
  SQL (`SEC008`), and four new rules:
  - `SEC011` prototype pollution
  - `SEC012` open redirect
  - `SEC013` server-side request forgery
  - `SEC014` regular expression built from request data

  Known cleaning steps stop a flow, and each only for the sinks it protects:
  numeric parsing and schema validation, `path.basename`, SQL/shell/regex
  escapers, and checks that exit early (allowlists, format regexes,
  `startsWith(root)` after `path.resolve`, `path.relative(...)` checks, a
  `new URL(x).origin` comparison, a relative-path test for redirects). Where a
  pattern finding and a flow agree, one finding remains at higher confidence;
  where the flow shows the value was cleaned, the pattern finding is dropped.
- **`devkit scan --since <ref>`** lists only findings on lines changed since a
  git ref, for pull-request checks. The score still covers the whole repository.
- **`devkit fix --write`** applies safe fixes: it removes exactly the import
  bindings the compiler reports as unused, deletes `console.log`/`console.debug`/
  `debugger` statements that are not a block's only statement, and turns a
  top-level `var` into `const`/`let` only when that is provably equivalent. Every
  changed file is re-checked and left alone if a fix would add a compile error.
- **`devkit doctor`** reports installed dependencies, the active tsconfig,
  workspaces, frameworks, entry points and unresolved imports. The same facts are
  a "Project" line in the scan header and `environment` in JSON.
- **`devkit init --interactive`** proposes ignores from detected frameworks
  (build output) and from the directories with the most findings, and writes
  `.devkitrc.json` without discarding existing settings. `--yes` accepts only
  the framework ones.
- **`devkit scan --with gitleaks,knip`** runs those tools when installed and
  merges their findings into the score and the SARIF output. Matched secrets are
  never copied into a finding, and a missing tool is a warning, not an error.
- **`--all` and `--audit`** flags (see the upgrade notes).
- **"Biggest score drains":** the three rules that cost the most points, with
  their cost, in the terminal, Markdown and JSON.
- **More secret formats:** Google, OpenAI, Anthropic, GitLab, npm, SendGrid,
  Twilio and Azure storage keys, Stripe publishable keys (as `INFO`), and
  database URLs with an embedded password. GitHub tokens are checked against
  GitHub's CRC32 checksum; a string that fails it is `LOW` confidence.
- **More TLS and SQL coverage:** `SEC007` flags `rejectUnauthorized: false`,
  `strictSSL: false`, `insecure: true` and a no-op `checkServerIdentity`;
  `SEC008` checks `raw`, `$queryRawUnsafe`, `$executeRawUnsafe`, `pool.query`,
  `client.query`, `knex.raw` and `sequelize.query`, and follows a query built
  into a variable before it is passed in.
- **Import cycles show the whole chain** with the importing line of each file
  (`a.ts:12 → b.ts:3 → a.ts`).
- **A benchmark** (`bench/`): a seeded repository with 40 planted issues and 23
  known-clean decoys, a pinned corpus of seven real repositories, 56 hand-assigned
  labels for 11 rules, `npm run bench` / `bench:check` / `bench:corpus` /
  `bench:sample` / `bench:report`, a CI gate that fails on a missed planted issue
  or a rule losing more than 2 accuracy points, and a generated
  [bench/ACCURACY.md](bench/ACCURACY.md).
- SARIF results carry `partialFingerprints` built from the stable finding id.
- Config option `scan.includeNonProduction`.

### Changed

- **Secret detection (`SEC001`) is reworked** and now lives in
  `src/rules/secrets.ts`. In TS/JS it reads string literals from the syntax
  tree, so comments are never flagged, and a name must *end* in a credential
  word (`dbPassword`, `API_KEY`; not `tokenizer` or `passwordHash`). JSON is
  parsed and only values are judged (keys and `dependencies`/`author`/
  `contributors` are skipped); in YAML, `.env` and TOML only the value is judged.
  A value must be one ASCII token that mixes character types and does not look
  like code; passwords need three character types. Sample credentials in tests,
  fixtures and docs are `INFO`; live-looking keys (`AKIA…`, `sk_live_…`, valid
  GitHub tokens) keep full severity there.
- **The score** counts production code only, and a rule's cost to a category is
  linear up to 2 points and logarithmic beyond.
- **`devkit --version`** now reports the real package version (it was
  hardcoded to `0.1.0`).
- **Dependency rules.** `DEP001` knows the executables of common tools
  (`typescript` → `tsc`, Biome, Vitest, ESLint, Prettier, tsx, tsup, turbo, …)
  when nothing is installed, counts packages referenced by a `node_modules/<pkg>`
  path or imported at the top of an MDX document, treats `sass`/`less`/`stylus`
  as used when files in their language exist, `tslib` as used under Angular, and
  a scoped plugin (`@size-limit/file`) as used with its tool. `DEP002` skips
  framework virtual modules when the framework is declared (Docusaurus,
  SvelteKit) and honors Vite, webpack, Rollup, Jest and Babel aliases.
- **Unused files and exports.** Workspace packages resolve by name without
  `node_modules` links (static and dynamic imports, `require.resolve`, `exports`
  maps); `.md`/`.mdx` imports and Docusaurus `@site/...` imports count; Docusaurus
  (`src/theme`, `src/pages`, …), NestJS `main.ts` and service workers are entry
  points; barrels are not reported; files in published packages are `LOW`
  confidence; wildcard `exports` patterns make matching sources public API;
  `src/index.*` and `main.*` are entry points when no `main`/`exports`/`bin` is
  set; a directory read through a runtime-built path is referenced; each
  unused-file finding says which checks it failed.
- **Per-rule fixes.** `ERR003` ignores `void | Promise` returns and
  `Object.assign` decorators and is `LOW` in React effects and `on*` handlers;
  `JS002` allows `typeof x != "undefined"` and `== undefined`; generated files
  are also detected by shape; `DUP001` reports one finding per cluster, skips
  `locale/`, `i18n/` and `fixtures/`, and ignores literal-heavy blocks.
- **Vendored code** (`vendor/`, `third_party/`, scripts under `assets/`) is not
  judged as the project's own code or scored.
- `devkit fix` previews only findings that are both fixable and HIGH/CERTAIN
  confidence.

### Fixed

- `SEC001` no longer reports translated UI strings (a sentence used as a JSON
  key, non-ASCII prose, hyphenated labels), Solidity `tokenId` variables, code
  comments, dependency and author fields in `package.json`, or Algolia's
  search-only key.
- The repository's own scan no longer reports its `SEC007` rule description as a
  TLS finding.
- The false-positive reduction that was already on `main` after 0.1.1:


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
