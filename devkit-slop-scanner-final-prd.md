# DevKit Slop Scanner

## Final Product Requirements Document

**Product:** DevKit\
**Feature:** Slop Scanner\
**Version:** V1\
**Status:** Final PRD\
**Primary platform:** Node.js CLI\
**LLM dependency:** None

------------------------------------------------------------------------

# 1. Executive Summary

DevKit Slop Scanner is a developer-focused command-line tool that
analyzes a JavaScript/TypeScript repository and produces a **Code
Quality / Slop Score from 0 to 10**.

The scanner identifies objectively measurable forms of code waste and
technical debt, including:

-   dead code
-   unused packages
-   unused imports and exports
-   duplicated code
-   unnecessary complexity
-   redundant logic
-   poor error handling
-   unsafe TypeScript patterns
-   architecture violations
-   security anti-patterns
-   test-quality problems
-   repository hygiene issues
-   configuration problems

V1 is intentionally **100% deterministic**.

It must not depend on:

-   an LLM
-   an AI API
-   internet connectivity
-   API keys
-   cloud inference
-   remote services

A future V2 may introduce an optional LLM semantic-analysis layer for
questions that cannot be reliably answered through static analysis.

------------------------------------------------------------------------

# 2. Product Definition

## What is "AI Slop"?

For DevKit, **AI slop is code that introduces unnecessary complexity,
duplication, abstraction, boilerplate, or maintenance cost without
proportional technical value.**

The product does not attempt to prove whether code was written by AI.

A human-written codebase can contain slop, and AI-generated code can be
clean.

Therefore, V1 measures the **observable characteristics of the
codebase**, not its authorship.

------------------------------------------------------------------------

# 3. Problem

Modern repositories accumulate technical waste through rapid
development, copy/paste, generated code, framework complexity,
incomplete refactors, and unused dependencies.

Typical examples:

``` text
Unused packages
Unused files
Unused exports
Dead functions
Duplicate code
Large functions
Deep nesting
Redundant conditions
Swallowed errors
Debug statements
Unsafe `any`
Circular dependencies
Architecture violations
Skipped tests
Committed build artifacts
```

Traditional linters usually report individual rule violations.

DevKit adds a repository-level perspective:

``` text
Code Quality: 7.8 / 10

Dead Code        8.4
Dependencies     7.1
Complexity       6.8
Duplication      8.7
Error Handling   7.9
Type Safety      9.1
Architecture     8.0
Security         8.8
Hygiene          6.9
Testing          7.4
```

Every score must be explainable through concrete findings.

------------------------------------------------------------------------

# 4. Goals

## Primary Goals

1.  Analyze an entire repository.
2.  Detect objectively measurable code waste.
3.  Produce a 0-10 repository score.
4.  Explain every score with concrete findings.
5.  Work completely offline.
6.  Run quickly enough for local development and CI.
7.  Produce machine-readable output.
8.  Provide safe deterministic fixes where possible.
9.  Support configurable rules.
10. Provide stable, reproducible results.

## Non-Goals for V1

V1 will not:

-   determine whether code was written by AI
-   use an LLM for analysis
-   make subjective architectural judgments
-   automatically redesign an application
-   autonomously rewrite large portions of code
-   predict developer productivity
-   judge developer skill
-   provide cloud-hosted analysis

------------------------------------------------------------------------

# 5. Target Users

### Software Developers

Understand where their repository contains unnecessary code and
complexity.

### Tech Leads

Identify technical debt and architectural problems.

### Engineering Managers

Get a high-level repository health signal backed by evidence.

### CI/CD Systems

Enforce quality gates.

### Developers Learning Software Engineering

Learn what makes a codebase unnecessarily complex or difficult to
maintain.

------------------------------------------------------------------------

# 6. V1 Architecture

``` text
                    DEVKIT CLI
                        |
                        v
                Project Loader
                        |
                        v
                File Discovery
                        |
          +-------------+-------------+
          |                           |
          v                           v
      AST Engine              Dependency Engine
          |                           |
          +-------------+-------------+
                        |
                        v
                   Rule Engine
                        |
                        v
                  Finding Engine
                        |
          +-------------+-------------+
          |                           |
          v                           v
     Score Engine                Fix Engine
          |                           |
          +-------------+-------------+
                        |
                        v
                    Reporter
```

Core components:

1.  CLI
2.  Project loader
3.  File discovery
4.  AST parser
5.  TypeScript/type-analysis engine
6.  Dependency graph
7.  Rule engine
8.  Finding engine
9.  Scoring engine
10. Fix engine
11. Configuration system
12. Cache/incremental analysis
13. Reporters

------------------------------------------------------------------------

# 7. Repository Discovery

DevKit must discover:

-   source files
-   test files
-   configuration files
-   package manifests
-   lockfiles
-   build configuration
-   framework configuration
-   Git metadata
-   entry points
-   generated files
-   ignored files

Support:

``` text
.gitignore
.devkitignore
```

Users must be able to override discovery rules.

------------------------------------------------------------------------

# 8. AST and Static Analysis Engine

The V1 scanner should use AST-based analysis rather than regex-only
analysis.

Initial language support:

-   JavaScript
-   TypeScript
-   JSX
-   TSX

Primary parser:

-   TypeScript Compiler API

The architecture must allow additional language adapters later.

------------------------------------------------------------------------

# 9. Dead Code Detection

Detect:

-   unused imports
-   unused variables
-   unused functions
-   unused classes
-   unused interfaces
-   unused type aliases
-   unused exports
-   unused constants
-   unused React components
-   unused routes where statically identifiable
-   unused environment variables where statically identifiable
-   unreachable statements
-   dead branches
-   unreachable modules
-   unused files

The dependency graph should be used to distinguish genuinely unreachable
files from files loaded through supported entry-point mechanisms.

------------------------------------------------------------------------

# 10. Dependency Hygiene

Analyze:

-   `package.json`
-   npm/yarn/pnpm lockfiles
-   static imports
-   `require()`
-   dynamic imports where statically identifiable

Detect:

-   unused dependencies
-   unused devDependencies
-   unlisted dependencies
-   duplicate dependency versions
-   dependency cycles
-   dependency depth
-   dependency bloat indicators

Dependency-bloat findings should initially be informational unless they
can be proven.

------------------------------------------------------------------------

# 11. Import Hygiene

Detect:

-   unused imports
-   duplicate imports
-   self-imports
-   circular imports
-   invalid imports
-   forbidden imports
-   cross-layer imports
-   deep/internal imports
-   inconsistent import patterns

------------------------------------------------------------------------

# 12. Code Duplication

Detect:

-   exact duplicate blocks
-   token-level duplication
-   structural AST duplication
-   duplicate functions
-   duplicate conditions
-   duplicate validation
-   duplicate configuration
-   duplicated error-handling patterns
-   duplicated type definitions

Each finding should report:

-   locations
-   similarity
-   affected lines
-   confidence

------------------------------------------------------------------------

# 13. Complexity Analysis

Calculate:

-   cyclomatic complexity
-   cognitive complexity
-   function length
-   file length
-   class size
-   parameter count
-   nesting depth
-   branch count
-   callback depth
-   statement count
-   return count
-   conditional count

The tool should report both individual outliers and repository-level
distributions.

Example:

``` text
Function: processUser()

Lines:              187
Cyclomatic:          18
Cognitive:           31
Parameters:           7
Nesting depth:        6

Risk: HIGH
```

------------------------------------------------------------------------

# 14. Redundant Logic

Detect:

-   redundant boolean comparisons
-   redundant conditions
-   duplicate condition checks
-   redundant conversions
-   redundant variables
-   redundant returns
-   redundant `try/catch`
-   redundant `await`
-   redundant optional chaining
-   redundant fallback expressions
-   impossible conditions
-   unnecessary boolean expressions

Only proven-safe simplifications should be automatically fixed.

------------------------------------------------------------------------

# 15. Error Handling

Detect:

-   empty catch blocks
-   swallowed exceptions
-   catch-and-rethrow without modification
-   promise rejection handling problems
-   floating promises
-   missing await where statically suspicious
-   ignored errors
-   generic error construction
-   inconsistent error handling patterns

The scanner must distinguish certain violations from informational
patterns.

------------------------------------------------------------------------

# 16. TypeScript Quality

Detect:

-   explicit `any`
-   implicit `any`
-   unsafe casts
-   `as any`
-   `@ts-ignore`
-   `@ts-nocheck`
-   non-null assertions
-   unused types
-   duplicate type definitions
-   unnecessary type assertions
-   overly broad types
-   unused generics
-   unsafe type escapes

------------------------------------------------------------------------

# 17. JavaScript Quality

Detect:

-   `var`
-   `==` where strict equality is expected
-   implicit globals
-   `eval`
-   unnecessary `new`
-   unnecessary callbacks
-   floating promises
-   async functions without `await`
-   unnecessary `async`
-   Promise constructor anti-patterns
-   ignored return values

Rules must be configurable because some projects intentionally use
certain patterns.

------------------------------------------------------------------------

# 18. React Analysis

For React projects, detect objectively measurable issues:

### Components

-   unused components
-   oversized components
-   excessive component complexity
-   unused props
-   unused state
-   missing list keys

### Hooks

-   incorrect hook usage
-   obvious missing dependency entries
-   obvious unnecessary dependency entries
-   state updates during render
-   obvious effect problems
-   unused `useMemo`
-   unused `useCallback`

Semantic questions such as "should this component exist?" are reserved
for V2.

------------------------------------------------------------------------

# 19. Architecture Analysis

DevKit must support explicit architecture rules.

Example:

``` yaml
architecture:
  layers:
    controllers:
      cannot_import:
        - database
        - repositories

    services:
      cannot_import:
        - controllers

    repositories:
      cannot_import:
        - controllers
        - services
```

Detect:

-   forbidden imports
-   layer violations
-   circular architecture
-   feature-boundary violations
-   frontend/backend boundary violations
-   direct database access where prohibited
-   cross-module violations

Architecture rules should be deterministic and user-defined.

------------------------------------------------------------------------

# 20. Security Static Analysis

V1 should detect deterministic security patterns including:

-   hardcoded secrets
-   API keys
-   passwords
-   tokens
-   `eval`
-   dangerous command execution
-   command-injection patterns
-   SQL-injection patterns
-   unsafe HTML rendering
-   dangerous `innerHTML`
-   weak cryptography
-   insecure random generation
-   disabled TLS verification
-   unsafe filesystem paths
-   unsafe deserialization

Security findings should be reported separately from ordinary
maintainability findings.

------------------------------------------------------------------------

# 21. Code Hygiene

Detect:

-   `console.log`
-   `console.debug`
-   `debugger`
-   TODO
-   FIXME
-   HACK
-   XXX
-   commented-out code
-   temporary files
-   backup files
-   generated artifacts
-   committed `.env` files
-   unusually large generated files

Users must be able to configure exclusions.

------------------------------------------------------------------------

# 22. Git Repository Hygiene

Where Git metadata is available, detect:

-   committed `.env` files
-   build artifacts
-   large files
-   binary artifacts
-   generated files
-   suspicious repository files
-   accidentally committed dependency directories

DevKit must not score individual developers or judge commit quality in
V1.

------------------------------------------------------------------------

# 23. Test Analysis

Detect:

-   source files without corresponding tests
-   functions without tests where statically mappable
-   empty tests
-   tests without assertions
-   skipped tests
-   focused tests such as `.only`
-   duplicate tests
-   oversized tests
-   excessive test complexity
-   mock-heavy tests

Consume existing coverage reports where available.

DevKit should not claim that lack of a test automatically means a bug.

------------------------------------------------------------------------

# 24. Configuration Analysis

Analyze:

-   `package.json`
-   `tsconfig.json`
-   ESLint configuration
-   Prettier configuration
-   Jest/Vitest configuration
-   Dockerfiles
-   Docker Compose files
-   CI configuration
-   `.gitignore`
-   `.devkitignore`

Detect:

-   unused scripts
-   missing scripts
-   inconsistent configuration
-   missing type checking
-   missing linting
-   missing tests
-   missing build verification
-   configuration duplication
-   conflicting configuration

------------------------------------------------------------------------

# 25. Repository Metrics

Report:

-   total files
-   source files
-   test files
-   total LOC
-   source LOC
-   test LOC
-   comment LOC
-   function count
-   class count
-   dependency count
-   average function size
-   largest functions
-   largest files
-   complexity distribution
-   duplication percentage
-   dead-code percentage
-   test/source ratio

Metrics should be accessible through:

``` bash
devkit metrics
```

------------------------------------------------------------------------

# 26. New V1 Feature: Baseline and Regression Detection

DevKit should support storing a baseline from a known-good scan.

Example:

``` bash
devkit baseline create
```

Future scans can compare against it.

Example:

``` text
Previous score: 8.2
Current score: 7.6

Regression: -0.6

New:
  4 dead-code findings
  2 complexity violations
  1 unused dependency

Resolved:
  7 previous findings
```

This allows DevKit to answer:

> "Did this change make the codebase worse?"

rather than only:

> "How good is the codebase right now?"

The baseline should be stored locally or in CI artifacts and must not
require a cloud service.

------------------------------------------------------------------------

# 27. New V1 Feature: Finding Suppression

Developers must be able to intentionally suppress a known finding.

Example:

``` ts
// devkit-disable-next-line TS001
const value = externalLibrary as any;
```

Also support configuration-level suppression:

``` yaml
rules:
  TS001:
    enabled: false
```

Every suppression should be visible in reporting.

DevKit should optionally detect stale suppressions where the underlying
issue no longer exists.

------------------------------------------------------------------------

# 28. New V1 Feature: Rule Documentation

Every rule must have:

-   rule ID
-   title
-   category
-   severity
-   confidence
-   explanation
-   example
-   why it matters
-   safe/unsafe fix classification
-   configuration options

Example:

``` text
TS001

Unsafe `any`

Why:
Removes compile-time type safety.

Severity:
Medium

Auto-fix:
No
```

CLI:

``` bash
devkit explain TS001
```

------------------------------------------------------------------------

# 29. New V1 Feature: Rule Presets

Provide presets:

``` text
default
strict
security
maintainability
ci
react
typescript
```

Example:

``` bash
devkit scan --preset strict
```

Users can override individual rules.

------------------------------------------------------------------------

# 30. New V1 Feature: Baseline-Aware Scoring

The scoring engine should support both:

### Absolute score

``` text
Current quality: 7.8 / 10
```

### Regression score

``` text
Previous: 8.2
Current: 7.8
Change: -0.4
```

This prevents teams from being forced to clean an entire legacy
repository before benefiting from DevKit.

A CI workflow can enforce:

``` text
Do not introduce new high-severity findings.
Do not decrease score by more than 0.2.
```

------------------------------------------------------------------------

# 31. New V1 Feature: Generated-Code Awareness

DevKit should identify files that appear to be generated using
deterministic signals such as:

-   generated-file markers
-   known generated directories
-   configured generated paths
-   generated-file comments
-   package/build metadata

Generated files should be excluded from normal code-quality scoring by
default when confidently identified.

This prevents generated code from distorting the repository score.

Users must be able to override this behavior.

------------------------------------------------------------------------

# 32. New V1 Feature: Monorepo Awareness

DevKit should support repositories containing multiple packages/apps.

Example:

``` text
apps/
  web/
  api/

packages/
  ui/
  database/
  config/
```

The scanner should provide:

-   repository-level score
-   package-level score
-   dependency relationships
-   cross-package violations
-   package-specific findings

Example:

``` text
Repository: 8.1

apps/web:       8.5
apps/api:       7.7
packages/ui:    8.8
packages/db:    7.9
```

------------------------------------------------------------------------

# 33. New V1 Feature: Ownership-Agnostic Reports

Reports must focus on files, modules, rules, and technical evidence.

They must not attempt to rank:

-   developers
-   teams
-   individual contributors

The purpose is codebase improvement, not developer surveillance.

------------------------------------------------------------------------

# 34. Finding Model

Every finding should contain:

``` text
id
ruleId
category
severity
confidence
file
line
column
message
description
evidence
suggestion
fixAvailable
```

Example:

``` json
{
  "ruleId": "DEP001",
  "category": "dependencies",
  "severity": "medium",
  "confidence": "certain",
  "file": "package.json",
  "message": "Unused dependency detected",
  "evidence": "No source import found"
}
```

------------------------------------------------------------------------

# 35. Severity Model

``` text
CRITICAL
HIGH
MEDIUM
LOW
INFO
```

Severity must represent the technical impact of the finding, not simply
how easy it is to fix.

------------------------------------------------------------------------

# 36. Confidence Model

``` text
CERTAIN
HIGH
MEDIUM
LOW
```

Examples:

``` text
Unused import
Confidence: CERTAIN
```

``` text
Potential dependency bloat
Confidence: LOW
```

Low-confidence findings should have limited impact on the overall score.

------------------------------------------------------------------------

# 37. Scoring Model

V1 score:

``` text
0.0 → 10.0
```

Where:

``` text
10 = very clean
0 = severe code-quality problems
```

Initial category weights:

  Category               Weight
  -------------------- --------
  Dead Code                 20%
  Dependency Hygiene        10%
  Complexity                15%
  Duplication               10%
  Redundant Logic           10%
  Error Handling            10%
  Type Safety               10%
  Architecture              10%
  Code Hygiene               5%

Security is reported separately initially.

The scoring system must account for:

-   severity
-   confidence
-   repository size
-   finding density
-   repeated violations

A single unused import should not destroy the score of a 100,000-line
repository.

------------------------------------------------------------------------

# 38. Score Explanation

Every score must be explainable.

Example:

``` text
Overall: 7.8 / 10

Main deductions:

- 12 unused exports
- 3 unused dependencies
- 5 high-complexity functions
- 7 duplicated blocks
- 4 swallowed exceptions
- 18 debug statements
```

The user must be able to trace a score back to findings.

------------------------------------------------------------------------

# 39. CLI Commands

``` bash
devkit init
```

Create DevKit configuration.

``` bash
devkit scan
```

Run the full scan.

``` bash
devkit scan --json
```

Machine-readable output.

``` bash
devkit scan --format sarif
```

SARIF output.

``` bash
devkit scan --format markdown
```

Markdown output.

``` bash
devkit scan --category dead-code
```

Run selected category.

``` bash
devkit scan --severity high
```

Show selected severity.

``` bash
devkit metrics
```

Show repository metrics.

``` bash
devkit report
```

Generate a detailed report.

``` bash
devkit fix
```

Apply safe fixes.

``` bash
devkit fix --dry-run
```

Preview fixes.

``` bash
devkit rules
```

List rules.

``` bash
devkit explain TS001
```

Explain a rule.

``` bash
devkit baseline create
```

Create a baseline.

``` bash
devkit baseline compare
```

Compare current state with the baseline.

------------------------------------------------------------------------

# 40. Configuration

Example:

``` yaml
project:
  name: my-project

scan:
  include:
    - src/**
    - packages/**
  exclude:
    - node_modules/**
    - dist/**
    - coverage/**
    - generated/**

architecture:
  enabled: true

security:
  enabled: true

testing:
  enabled: true

rules:
  complexity/function-lines:
    max: 100

  complexity/cognitive:
    max: 15

  typescript/no-any:
    severity: medium

  hygiene/no-console:
    severity: low
```

------------------------------------------------------------------------

# 41. Auto-Fix

V1 should only automatically apply transformations that can be proven
safe.

Examples:

-   remove unused imports
-   remove certain unused variables
-   simplify proven-safe boolean expressions
-   remove unreachable statements
-   remove debug statements when explicitly configured

Potentially unsafe operations such as deleting files, removing
dependencies, merging functions, or restructuring architecture should
not be automatic by default.

Use:

``` bash
devkit fix --dry-run
```

to preview changes.

------------------------------------------------------------------------

# 42. Output Formats

## Terminal

Primary developer experience.

## JSON

For automation and integrations.

## SARIF

For CI/code-scanning platforms.

## Markdown

For pull requests, documentation, and reports.

------------------------------------------------------------------------

# 43. CI/CD Integration

Support:

``` bash
devkit scan --min-score 7
```

Exit:

``` text
0 = pass
1 = fail
```

Also:

``` bash
devkit scan --fail-on high
```

Baseline-aware CI:

``` bash
devkit baseline compare
```

Possible policies:

``` text
No new HIGH findings
No new CRITICAL findings
No score regression greater than 0.2
```

------------------------------------------------------------------------

# 44. Performance

Initial targets:

``` text
Startup: < 500ms
Small project: < 2 seconds
Medium project: < 10 seconds
```

Large projects should use:

-   caching
-   incremental analysis
-   parallel file processing where safe

Exact thresholds should be benchmarked during implementation.

------------------------------------------------------------------------

# 45. Incremental Analysis

DevKit should cache:

-   file hashes
-   AST metadata
-   dependency graph information
-   previous findings
-   metrics

Example:

``` text
.devkit/
```

When only one file changes, DevKit should avoid unnecessarily rescanning
the entire repository.

------------------------------------------------------------------------

# 46. Rule Engine

Each rule should be modular.

Conceptual structure:

``` text
Rule
├── ID
├── Category
├── Severity
├── Confidence
├── Detector
├── Message
├── Documentation
└── Fix
```

Example:

``` text
DEAD001
DEAD002
DEP001
COMPLEX001
DUP001
ERR001
TS001
SEC001
ARCH001
HYGIENE001
```

------------------------------------------------------------------------

# 47. Rule Lifecycle

Rules should support:

``` text
experimental
stable
deprecated
disabled
```

This allows new rules to be introduced without destabilizing CI.

------------------------------------------------------------------------

# 48. V1 Technology Direction

Recommended stack:

### Runtime

Node.js

### Language

TypeScript

### CLI

Commander.js or equivalent

### Parsing

TypeScript Compiler API

### File discovery

fast-glob or equivalent

### Configuration

cosmiconfig or equivalent

### Testing

Vitest

### Terminal UI

A lightweight terminal formatting/table library

### Packaging

npm

The implementation should avoid unnecessary dependencies because the
product itself is designed to identify dependency bloat.

------------------------------------------------------------------------

# 49. Development Phases

## Phase 1: CLI Foundation

-   project initialization
-   CLI commands
-   configuration
-   logging
-   exit codes

## Phase 2: File and AST Engine

-   file discovery
-   AST parsing
-   source locations
-   project model

## Phase 3: Dead Code

-   unused imports
-   unused variables
-   unused functions
-   unused exports
-   unused files
-   unreachable code

## Phase 4: Dependencies

-   unused dependencies
-   unlisted dependencies
-   duplicate dependencies
-   dependency graph
-   circular dependencies

## Phase 5: Complexity

-   LOC
-   function size
-   file size
-   cyclomatic complexity
-   cognitive complexity
-   nesting depth
-   parameter count

## Phase 6: Code Smells

-   redundancy
-   duplication
-   error handling
-   console/debug detection
-   TODO/FIXME
-   TypeScript safety

## Phase 7: Architecture

-   dependency rules
-   layer rules
-   module boundaries

## Phase 8: Security

-   secret detection
-   dangerous APIs
-   injection patterns
-   crypto checks

## Phase 9: Testing

-   source/test mapping
-   test quality metrics
-   coverage integration

## Phase 10: Scoring

-   category scores
-   severity
-   confidence
-   repository score

## Phase 11: Reporting

-   terminal
-   JSON
-   Markdown
-   SARIF

## Phase 12: Baseline and Regression

-   baseline creation
-   comparison
-   score regression
-   new findings
-   resolved findings

## Phase 13: Safe Auto-Fix

-   safe transformations
-   dry runs
-   patch/diff output

------------------------------------------------------------------------

# 50. V1 Definition of Done

V1 is complete when:

``` bash
npx devkit scan
```

can analyze a real JavaScript/TypeScript repository and provide:

1.  Repository score from 0-10.
2.  Category-level scores.
3.  Dead-code findings.
4.  Dependency findings.
5.  Complexity findings.
6.  Duplication findings.
7.  Redundant-code findings.
8.  Error-handling findings.
9.  TypeScript findings.
10. Architecture findings.
11. Security findings.
12. Code-hygiene findings.
13. Test-quality metrics.
14. Configuration findings.
15. Repository metrics.
16. File and line references.
17. Severity for every finding.
18. Confidence for every finding.
19. JSON output.
20. SARIF output.
21. Markdown output.
22. CI-compatible exit codes.
23. Configurable rules.
24. Rule documentation.
25. Finding suppression.
26. Baseline comparison.
27. Monorepo support.
28. Generated-code awareness.
29. Safe deterministic fixes.
30. Incremental scanning.

The following must be true:

``` text
No API key required.
No LLM required.
No network required.
No cloud service required.
```

------------------------------------------------------------------------

# 51. V2: Optional LLM Semantic Engine

V2 should extend V1 rather than replace it.

The LLM should be invoked only for ambiguous, semantic questions.

Potential V2 features:

-   unnecessary abstraction detection
-   over-engineering detection
-   semantic duplication analysis
-   architecture reasoning
-   naming quality
-   comment quality
-   intent analysis
-   React architectural reasoning
-   test-quality reasoning
-   repository-level reasoning
-   refactoring recommendations
-   natural-language explanations
-   AI-style code-pattern analysis

Example:

``` bash
devkit scan
```

remains fully deterministic.

Optional:

``` bash
devkit scan --ai
```

activates semantic analysis.

------------------------------------------------------------------------

# 52. V2 Architecture

``` text
                    DEVKIT
                       |
               Static Analysis
                       |
             +---------+---------+
             |                   |
      Deterministic         Suspicious
        Findings             Findings
                                 |
                                 v
                         Optional LLM
                                 |
                                 v
                       Semantic Findings
                                 |
                         +-------+
                         |
                         v
                    Final Report
```

The LLM should never replace deterministic analysis.

------------------------------------------------------------------------

# 53. Design Principle

The fundamental DevKit rule is:

> **Never use an LLM to answer a question that static analysis can
> answer deterministically.**

Examples:

``` text
"Is this import unused?"
→ Static analysis

"Is this dependency unused?"
→ Static analysis

"How complex is this function?"
→ Static analysis

"Is this function unnecessarily abstracted?"
→ Potentially semantic analysis

"Does this abstraction represent a legitimate domain boundary?"
→ Potentially semantic analysis

"Is this duplicated code intentionally different?"
→ Potentially semantic analysis
```

------------------------------------------------------------------------

# 54. Success Metrics

## Detection

-   rule coverage
-   false-positive rate
-   false-negative rate
-   detection accuracy

## Performance

-   startup time
-   scan time
-   incremental scan time
-   memory usage

## Developer Experience

-   time to first result
-   report readability
-   configuration simplicity
-   fix safety

## CI

-   stable exit codes
-   valid SARIF
-   reproducible scans
-   baseline reliability

------------------------------------------------------------------------

# 55. Product Philosophy

DevKit is not intended to tell developers:

> "Your code is bad."

It should tell them:

> "Here is measurable evidence of where your codebase contains
> unnecessary complexity, waste, risk, or maintenance cost."

The score is only useful when the findings behind it are useful.

Therefore:

``` text
Evidence first
Scoring second
Automation third
Semantic AI later
```

------------------------------------------------------------------------

# 56. Final Product Boundary

## V1

``` text
              DEVKIT V1

     +-------------------------+
     | Deterministic Analysis  |
     +-------------------------+
                 |
       +---------+---------+
       |         |         |
     AST      Graph      Rules
       |         |         |
       +---------+---------+
                 |
           Findings
                 |
             Scoring
                 |
       +---------+---------+
       |                   |
     Report              Fix
```

## V2

``` text
              DEVKIT V2

                 V1
                  |
          Suspicious Findings
                  |
             Optional LLM
                  |
        Semantic Interpretation
                  |
        Refactoring Suggestions
```

The V1 product must remain fully useful without V2.

------------------------------------------------------------------------

# 57. Final V1 Feature Inventory

### Repository

-   file discovery
-   project detection
-   monorepo support
-   generated-code detection
-   Git hygiene

### Dead Code

-   unused imports
-   unused variables
-   unused functions
-   unused classes
-   unused types
-   unused exports
-   unused constants
-   unused files
-   unreachable code
-   dead branches
-   unused components
-   unused routes
-   unused environment variables

### Dependencies

-   unused packages
-   unused devDependencies
-   unlisted dependencies
-   duplicate versions
-   dependency cycles
-   dependency depth
-   dependency bloat indicators

### Code Structure

-   AST analysis
-   import analysis
-   duplication detection
-   complexity metrics
-   redundancy detection
-   circular dependencies
-   architecture rules

### TypeScript / JavaScript

-   `any`
-   unsafe casts
-   `@ts-ignore`
-   non-null assertions
-   implicit any
-   `var`
-   loose equality
-   floating promises
-   unnecessary async
-   Promise anti-patterns

### React

-   unused components
-   unused props
-   unused state
-   missing keys
-   hook violations
-   obvious dependency issues
-   oversized components
-   unnecessary memoization candidates

### Error Handling

-   empty catches
-   swallowed exceptions
-   redundant rethrows
-   floating promises
-   ignored errors

### Security

-   hardcoded secrets
-   dangerous APIs
-   injection patterns
-   unsafe HTML
-   weak crypto
-   insecure randomness
-   TLS problems
-   unsafe deserialization
-   path traversal patterns

### Hygiene

-   console statements
-   debugger
-   TODO
-   FIXME
-   HACK
-   XXX
-   commented-out code
-   temporary files
-   generated artifacts
-   committed `.env`

### Testing

-   missing tests
-   empty tests
-   missing assertions
-   skipped tests
-   focused tests
-   duplicate tests
-   test complexity
-   mock-heavy tests
-   coverage integration

### Configuration

-   unused scripts
-   missing scripts
-   missing linting
-   missing type checking
-   missing tests
-   missing build checks
-   configuration duplication
-   conflicting configuration

### Reporting

-   0-10 score
-   category scores
-   severity
-   confidence
-   evidence
-   terminal output
-   JSON
-   Markdown
-   SARIF
-   rule documentation

### Developer Workflow

-   safe auto-fix
-   dry-run fixes
-   suppressions
-   rule presets
-   baseline
-   regression detection
-   incremental scanning
-   CI quality gates

------------------------------------------------------------------------

# 58. Final Statement

DevKit V1 is a **deterministic repository-quality analyzer**, not an AI
code detector.

Its job is to answer:

> **"Where is this codebase carrying unnecessary code, complexity,
> duplication, risk, and maintenance cost?"**

It should answer that question using evidence that can be reproduced
locally without an LLM.

V2 can later answer the harder question:

> **"Is this complexity actually justified by the intent and
> architecture of the system?"**

That separation keeps the core product fast, offline, explainable,
testable, and independent of any AI provider.
