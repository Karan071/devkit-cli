# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
