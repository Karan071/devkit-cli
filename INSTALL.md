# Install and use DevKit with a React project

DevKit is a command-line scanner for JavaScript and TypeScript repositories. It runs from your React project's root directory and scans source files such as `.js`, `.jsx`, `.ts`, and `.tsx`. It is not a React component and does not need to be imported into your app. It runs offline and does not call an LLM or any network service.

There are two ways to use it:

- **Run it without installing** (quickest): `npx devkit-quality scan` from your project root.
- **Link a local checkout** (to work on DevKit itself, or to try unreleased changes): the steps below use `npm link`.

## Requirements

- Node.js `^22.12.0`, `^24.0.0`, or `>=26.0.0` (Node 18 and 20 are not supported)
- npm
- A React project with a `package.json`
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

`fix --write` re-checks every changed file and leaves it untouched if a fix would add a compile error. Review the diff and run your tests afterwards.

## Run DevKit's own checks

To work on DevKit itself, return to its checkout and run the test suite and TypeScript build:

```bash
cd /path/to/devkit
npm test
npm run build
```

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

For configuration, scoring and CI details, see the [README](README.md).
