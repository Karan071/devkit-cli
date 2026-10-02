# Security Policy

## Supported versions

DevKit is pre-1.0. Security fixes are made to the latest published version on npm and the `main` branch only.

## Reporting a vulnerability

Please do not open a public GitHub issue for security vulnerabilities.

Instead, report it privately using [GitHub's private vulnerability reporting](https://github.com/Karan071/devkit-cli/security/advisories/new) for this repository. If that is not available, open a regular issue asking a maintainer to contact you privately, without describing the vulnerability.

Include as much detail as you can:

- A description of the issue and its potential impact
- Steps to reproduce (a minimal repository or command is ideal)
- The DevKit version and Node.js version you're using

We'll acknowledge reports as soon as possible and follow up with a fix timeline.

## Scope notes

DevKit runs entirely offline and does not transmit scanned source code anywhere. The main security-relevant surfaces are:

- File system access while walking a target repository (`src/discovery.ts`, `src/ignore.ts`)
- Parsing untrusted source files with the TypeScript Compiler API (`src/ast/`)
- Loading `.devkitrc.json` configuration (`src/config.ts`)

Reports involving path traversal, arbitrary code execution during a scan, or config-driven file writes outside the target project are especially welcome.
