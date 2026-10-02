# Install and use DevKit with a React project

DevKit is a command-line scanner for JavaScript and TypeScript repositories. It runs from your React project's root directory and scans source files such as `.js`, `.jsx`, `.ts`, and `.tsx`. It is not a React component and does not need to be imported into your app.

These steps use `npm link` to make the local DevKit checkout available as a command in your React project.

## Requirements

- Node.js and npm installed
- A React project created with a `package.json`

## 1. Install and build DevKit

Open a terminal in the DevKit checkout directory. If you are elsewhere, change to the directory where you cloned or downloaded DevKit:

```bash
cd /path/to/devkit
```

Install its dependencies and compile the TypeScript source:

```bash
npm install
npm run build
```

## 2. Register the DevKit command locally

From the DevKit directory, run:

```bash
npm link
```

This registers the package's `devkit` command with your local npm installation.

## 3. Link DevKit into your React project

Change to the root directory of your React app. Replace the example path with the actual path to your project:

```bash
cd /path/to/react-app
npm link devkit
```

Run the next commands from this React project directory so DevKit scans the correct files.

## 4. Create a DevKit config

Create the default configuration file in your React project:

```bash
npx devkit init
```

This creates `.devkitrc.json` in the current directory. The default config includes `src/**` and `packages/**`, and excludes common generated and dependency folders.

## 5. Scan the React project

Run a standard scan:

```bash
npx devkit scan
```

Choose another output format when useful:

```bash
npx devkit scan --format markdown
npx devkit scan --format json
npx devkit scan --format sarif
```

Filter findings by severity or category:

```bash
npx devkit scan --severity HIGH
npx devkit scan --category security
```

Use quality gates in a script or CI job. These commands return a failing exit code when the selected threshold is not met:

```bash
npx devkit scan --fail-on HIGH
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
npx devkit explain DEAD002
```

Save the current score as a baseline and compare later scans against it:

```bash
npx devkit baseline create
npx devkit baseline compare
```

Preview findings that DevKit marks as safe to fix:

```bash
npx devkit fix
```

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
npm unlink devkit
```

To remove the global npm link, run this from the DevKit directory:

```bash
cd /path/to/devkit
npm unlink
```
