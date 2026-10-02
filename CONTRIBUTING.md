# Contributing to DevKit

Thanks for your interest in improving DevKit. This guide covers how to set up the project, the conventions the codebase follows, and how to submit a change.

## Ground rules

- DevKit never calls an LLM, an API, or the network to produce a finding. Every rule must be deterministic and reproducible from the source tree alone. If a contribution needs a network call or a model call to work, it belongs in a different project.
- A rule's output must be explainable: a file, a line, a reason, and a concrete suggested fix.

## Getting set up

```bash
git clone https://github.com/Karan071/devkit-cli.git
cd devkit-cli
npm install
npm run build
npm test
```

Run the CLI directly against this repository (or any other) without a build step:

```bash
npm run dev -- scan
```

## Project layout

See [README.md](README.md#project-layout) and [README.md](README.md#architecture) for how discovery, parsing, the module graph, rules, scoring, and reporting fit together.

## Adding or changing a rule

1. Pick the category file under `src/rules/` (or create one for a new category) and add/modify the `run*Rules(context)` function.
2. Register the rule's metadata (id, title, category, severity, confidence, docs) in `src/rules.ts`.
3. Add test cases in `src/__tests__/`: at least one snippet that should trigger the finding and one that should not. Use `src/__tests__/testUtils.ts` to build a minimal `RuleContext`.
4. Run `npm test` and `npm run build`.
5. Update `README.md`'s rule table if you added a new rule ID or category.

Keep new rules deterministic, low false-positive, and scoped to one concern per rule ID.

## Submitting a change

1. Fork the repo and create a branch from `main`.
2. Make your change with tests. Keep the diff focused — unrelated formatting or refactors make review harder.
3. Run `npm run build && npm test` locally; CI runs the same checks on Node 18/20/22.
4. Open a pull request describing the problem and the fix. Reference any related issue.
5. Be responsive to review feedback — small, iterative changes merge faster than large ones.

## Reporting bugs and requesting features

Use [GitHub Issues](https://github.com/Karan071/devkit-cli/issues). For a bug, include: the command you ran, expected vs. actual output, and your Node.js version. For a rule you think is a false positive, include the smallest code snippet that reproduces it.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.
