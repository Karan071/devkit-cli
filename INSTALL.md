# Install and use DevKit with a React project

DevKit is a command-line scanner for JavaScript and TypeScript repositories. It runs from your React project's root directory and scans source files such as `.js`, `.jsx`, `.ts`, and `.tsx`. It is not a React component and does not need to be imported into your app. It runs offline and does not call an LLM or any network service.

> **Which version do you have?** Run `devkit --version` (or `npx devkit-quality --version`). The commands marked **0.2.0** in this guide (`doctor`, `fix --write`, `scan --since`, `scan --with`, `--all`, `--audit`, `init --interactive`) and the new security rules (`SEC011`–`SEC014`) need 0.2.0 or later. `npm view devkit-quality version` shows what is published; if it is older than 0.2.0, use a local checkout (below) or the source from the GitHub release.

There are two ways to use it:

- **Run it without installing** (quickest): `npx devkit-quality scan` from your project root.
- **Link a local checkout** (to work on DevKit itself, or to try unreleased changes): the steps below use `npm link`.

## Requirements

- Node.js `^22.12.0`, `^24.0.0`, or `>=26.0.0` (Node 18 and 20 are not supported)
- npm
- A React project with a `package.json`
- Your project's own dependencies installed (`npm install`, `pnpm install`, …). DevKit works without them, but type-based findings are then reported at low confidence and a warning says so
- A git repository, if you want `scan --since` (it compares against a git ref)
- Optional: `gitleaks` and `knip` on your `PATH`, if you want to use `scan --with`

## Quick start (no install)

From your React project's root directory:

```bash
npx devkit-quality scan
```

The published package installs the `devkit` command, so after `npm install -g devkit-quality` you can run `devkit scan` instead.

## Use a local checkout

### 1. Install and build DevKit

Open a terminal in the DevKit checkout directory. If you are elsewhere, change to the directory where you cloned or downloaded DevKit:

```bash
cd /path/to/devkit
```

Install its dependencies and compile the TypeScript source:

```bash
npm install
npm run build
```

### 2. Register the DevKit command locally

From the DevKit directory, run:

```bash
npm link
```

This registers the package's `devkit` command with your local npm installation.

### 3. Link DevKit into your React project

Change to the root directory of your React app. Replace the example path with the actual path to your project:

```bash
cd /path/to/react-app
npm link devkit-quality
```

The package is named `devkit-quality`; the command it provides is `devkit`. Run the next commands from this React project directory so DevKit scans the correct files.

## Set up and scan

### 1. Check that the project can be analyzed

```bash
npx devkit doctor
```

This reports whether dependencies are installed, which `tsconfig.json` is used, and which workspaces, frameworks and entry points were detected, and how many imports could not be resolved. Run `npm install` in your project first if dependencies are missing: unresolved imports lower the accuracy of the dead-code and dependency rules.

### 2. Create a DevKit config

Create the default configuration file in your React project:

```bash
npx devkit init
```

This creates `.devkitrc.json` in the current directory. The default config includes `src/**` and `packages/**`, and excludes common generated and dependency folders.

To have DevKit scan first and propose ignores for you, run:

```bash
npx devkit init --interactive
```

It suggests ignores for your framework's build output and for the directories that hold most of the findings, and asks before adding each one. Add `--yes` to accept only the framework build-output ignores without prompting.

### 3. Scan the React project

Run a standard scan:

```bash
npx devkit scan
```

The terminal report shows a boxed header, the score with a letter grade, the biggest score drains, and panels for scan coverage, per-category scores, severity counts, file hotspots, the worst finding per category, and next steps. Set `NO_COLOR=1` to turn colors off, or `DEVKIT_ASCII=1` for plain-ASCII glyphs if your terminal does not render the box and bar characters.

### Reading the report

The terminal report is DevKit's interface (there is no separate graphical or web app). From top to bottom:

1. **Header box** — the tool and the path being scanned.
2. **Score** — `x / 10`, a letter grade, and a bar. A `▲ Capped at 6.9` line means a serious, confident security finding limited the score however clean the rest is. Fix that first.
3. **Biggest score drains** — the three rules costing the most points, with their cost (for example `-0.49`) and how many findings each has. This is the quickest way to raise the score.
4. **Scan coverage** — files found, analyzed and secret-scanned; lines of code; what was skipped; and a **Project** line (dependencies installed? tsconfig, packages, frameworks, entry points, unresolved imports). Yellow warnings here, such as "dependencies are not installed", explain why some findings are low confidence.
5. **Categories** — one bar per category. `✔ clean` means no findings; `n/a` for Architecture means no layers are configured.
6. **Findings, Hotspots** — severity counts, and the files that cost the most points.
7. **Top issues** — the worst finding in each category, with an explanation, a suggested fix and a code frame at the exact line.
8. **Next steps** — how many findings were not shown, and how many lower-confidence findings were hidden by default.

By default the report lists only findings worth acting on, so a short list does not mean the rest was ignored: the **hidden** count in *Next steps* says how many were left out, and `--all` shows them. Findings marked `INFO` (for example a public Firebase key, or a sample credential in a test) are shown but cost no points. For the reasoning behind any rule, run `npx devkit explain <RULE_ID>`.

Choose another output format when useful:

```bash
npx devkit scan --format markdown
npx devkit scan --format json        # same as --json
npx devkit scan --format sarif
```

Filter findings by severity or category:

```bash
npx devkit scan --severity high
npx devkit scan --category security
```

By default the report lists only findings worth acting on. To see more:

```bash
npx devkit scan --all      # also low-confidence findings and rules with low measured accuracy
npx devkit scan --audit    # --all, plus findings in tests, examples, benchmarks and fixtures
```

Scores always cover the whole repository, whatever you filter.

To silence a finding you have decided to accept, add a comment: `// devkit-disable-next-line SEC009` (the next line) or `// devkit-disable-file DUP001` (the whole file). Without rule IDs, every rule is silenced.

Check only what a pull request changed:

```bash
npx devkit scan --since origin/main
```

Merge findings from other tools that are installed (`gitleaks`, `knip`):

```bash
npx devkit scan --with gitleaks,knip
```

Use quality gates in a script or CI job. These commands return a failing exit code when the selected threshold is not met:

```bash
npx devkit scan --fail-on high
npx devkit scan --min-score 8
```

`--min-score` always uses the whole repository; `--fail-on` gates on the findings that are listed, so with `--since` it fails only on what changed.

### Use it in CI

A minimal GitHub Actions job that fails a pull request on new high-severity findings and on a low overall score:

```yaml
name: DevKit
on:
  pull_request:
    branches: [main]
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # --since needs the base branch's history
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci                # install dependencies so type-based findings are reliable
      - run: npx devkit-quality@0.2.0 scan --since origin/${{ github.base_ref }} --fail-on high
      - run: npx devkit-quality@0.2.0 scan --min-score 7
```

Pin the version (`@0.2.0`) so a new release cannot change your gate. This needs 0.2.0 to be published on npm: if `npm view devkit-quality version` still shows 0.1.x, build DevKit from its repository in the job instead of using `npx`. To send results to GitHub code scanning, add `scan --format sarif > devkit.sarif` and upload it with `github/codeql-action/upload-sarif`; the README has the full workflow.

## Other commands

Print a detailed Markdown report:

```bash
npx devkit report
```

Print repository metrics:

```bash
npx devkit metrics
```

List built-in rules or get details for a rule:

```bash
npx devkit rules
npx devkit explain DEAD010
```

Save the current score as a baseline and compare later scans against it:

```bash
npx devkit baseline create
npx devkit baseline compare
```

Preview the safe fixes, then apply them:

```bash
npx devkit fix            # preview only
npx devkit fix --write    # apply: unused imports, console.log/debug, var -> let/const
```

`fix --write` re-checks every changed file and leaves it untouched if a fix would add a compile error. Review the diff and run your tests afterwards. Commit or stash your own changes first so the diff contains only DevKit's edits.

## Run DevKit's own checks

To work on DevKit itself, return to its checkout and run the test suite and TypeScript build:

```bash
cd /path/to/devkit
npm test
npm run build
npm run bench:check     # the accuracy gate CI runs: planted issues and per-rule accuracy
```

`npm run bench` prints the full catch-rate and accuracy report. To see how the scanner is measured, read [bench/README.md](bench/README.md); the published per-rule accuracy is in [bench/ACCURACY.md](bench/ACCURACY.md).

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `devkit: command not found` | With a local checkout, run `npm run build` and `npm link` in the DevKit directory, then `npm link devkit-quality` in your project. With `npx`, use `npx devkit-quality …` (the package is `devkit-quality`; the command it installs is `devkit`). |
| `unknown command 'doctor'` or `unknown option '--since'` | You are on a version older than 0.2.0. Check `devkit --version`; use a local checkout or update. |
| A warning says dependencies are not installed | Run your package manager's install, then scan again. Until then `TS001` and `ERR003` are low confidence and hidden by default. `devkit doctor` shows the exact command. |
| "No JavaScript/TypeScript files were analyzed" | Run `devkit` from the project root, and check `scan.include`/`scan.exclude` in `.devkitrc.json` and your `.devkitignore`. |
| Far fewer findings than expected | The default view hides lower-confidence findings; see the hidden count under *Next steps* and use `--all`. Tests, examples and fixtures need `--audit`. |
| `--since` fails immediately | The ref does not exist locally. In CI, fetch history (`fetch-depth: 0`) and use `origin/<branch>`. |
| `--with gitleaks,knip` prints a warning | The tool is not on your `PATH` or in `node_modules/.bin`, or printed output DevKit could not read. The built-in scan still completes. |
| Box and bar characters look broken | Set `DEVKIT_ASCII=1`. Set `NO_COLOR=1` to remove colors. |
| Scores differ from an older DevKit | 0.2.0 scores production code only and caps any one rule's cost. Re-create a stored baseline with `devkit baseline create`. |
| The scan is slow on a very large repository | Exclude generated or vendored folders in `.devkitrc.json`, or run `devkit init --interactive` to get suggestions. |

## Unlink DevKit

If you no longer want the React project linked to this local checkout, run this from the React project directory:

```bash
npm unlink devkit-quality
```

To remove the global npm link, run this from the DevKit directory:

```bash
cd /path/to/devkit
npm unlink
```

For configuration, scoring, taint tracking and CI details, see the [README](README.md). For what changed in each release, see the [CHANGELOG](CHANGELOG.md).
