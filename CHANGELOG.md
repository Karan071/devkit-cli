# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

- Open-sourced the project: contributing guide, code of conduct, security
  policy, issue/PR templates, and CI.
- Fixed the published CLI command name (`devkit`) to match the `bin` entry in
  `package.json`.

## [0.1.0]

- Initial release: deterministic scan pipeline (discovery, TypeScript
  Compiler API parse, module graph, rules, scoring, reporting).
- Rule categories: dead code, dependencies, complexity, duplication, error
  handling, redundant logic, TypeScript safety, JavaScript hygiene, security,
  architecture, repository hygiene.
- Terminal, JSON, Markdown, and SARIF output formats.
- `devkit init`, `scan`, `report`, `metrics`, `rules`, `explain`, `baseline`,
  and `fix` commands.
