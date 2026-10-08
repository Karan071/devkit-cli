import path from 'node:path';
import { readFileSafe } from './discovery';

/**
 * Evidence that a declared dependency is used even though no JS/TS file imports it.
 *
 * Nothing here is keyed on specific package names. Every signal is derived from the project itself
 * or from the installed manifests in node_modules:
 *   - tool config files (`<tool>.config.*`, `.<tool>rc`) mention the plugins they load and imply the tool
 *   - stylesheets reference packages through `@import` / `@plugin` / `@use`
 *   - top-level package.json fields (`prettier`, `eslintConfig`, `browserslist`, ...) name packages
 *   - installed packages declare peer dependencies that must be present at runtime
 */

const TOOL_CONFIG_BASENAME = /^\.?([a-z][\w-]*?)(?:\.config|rc)?(?:\.[\w-]+)*(?:\.(?:[cm]?[jt]sx?|json|ya?ml|toml))?$/i;
const TOOL_CONFIG_FILE = /^(?:\.[\w-]+rc(?:\.[\w-]+)?|[\w-]+\.config\.[\w-]+|[tj]sconfig(?:\.[\w.-]+)?\.json)$/;
// Data-format config files at any depth: nx.json, .eslintrc.json, .swcrc, vercel.json, renovate.json, pyproject-style toml, CI yaml.
const DATA_CONFIG_FILE = /\.(?:jsonc?|ya?ml|toml|ini|cfg)$/i;
const NEVER_CONFIG_DATA = /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|composer\.json)$/i;
const MAX_CONFIG_BYTES = 300_000;
// `eslint-plugin-react`, `eslint-config-next`, `prettier-plugin-x`, `@scope/babel-preset-y`: tools refer to these by a short name.
const TOOL_PACKAGE_CONVENTION = /^(?:@([^/]+)\/)?([a-z0-9]+)-(?:[a-z0-9]+-)?(?:plugin|config|preset|parser|loader|transformer|transform|resolver|environment|reporter|runner|adapter)(?:-(.+))?$/;
// Standalone extension names inside a scope: `@typescript-eslint/parser`, `@babel/preset-env`, `@scope/plugin-x`.
const SCOPED_EXTENSION = /^@[^/]+\/(?:parser|plugin|preset|loader|transformer|eslint-plugin|(?:plugin|preset|loader)-.+)$/;
const STYLE_FILE = /\.(?:css|scss|sass|less|pcss|styl)$/i;
const STYLE_IMPORT = /@(?:import|use|forward|plugin|config|reference)\s+(?:url\(\s*)?["']([^"']+)["']/g;
// Fields defined by the npm package.json spec itself. Anything else at the top level is tool configuration.
const STANDARD_PACKAGE_FIELDS = new Set([
    'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'peerDependenciesMeta', 'bundledDependencies',
    'scripts', 'name', 'version', 'description', 'main', 'module', 'types', 'typings', 'type', 'files', 'exports', 'imports', 'bin',
    'man', 'engines', 'os', 'cpu', 'repository', 'bugs', 'homepage', 'keywords', 'license', 'author', 'contributors', 'funding',
    'private', 'workspaces', 'publishConfig', 'sideEffects', 'packageManager', 'browser', 'directories', 'config', 'overrides',
    'resolutions', 'pnpm', 'volta'
]);

/**
 * Plugins, presets, parsers and environments are loaded *by name inside the tool that hosts them* and never imported
 * by project code, so "no reference found" is weak evidence for them: the reference may be implicit in another config.
 */
export function looksLikeToolExtension(name: string): boolean {
    return TOOL_PACKAGE_CONVENTION.test(name) || SCOPED_EXTENSION.test(name);
}

export function packageNameFromSpecifier(specifier: string): string {
    const bare = specifier.replace(/^~/, '');
    if (bare.startsWith('@')) return bare.split('/').slice(0, 2).join('/');
    return bare.split('/')[0];
}

function isBareSpecifier(specifier: string): boolean {
    return !(specifier.startsWith('.') || specifier.startsWith('/') || /^[a-z]+:/i.test(specifier) || specifier.startsWith('#'));
}

/** Names that tools commonly shorten: `tailwind.config.js` belongs to `tailwindcss`, `.babelrc` to `@babel/core`. */
function packageMatchesTool(dependency: string, tool: string): boolean {
    const unscoped = dependency.startsWith('@') ? dependency.split('/')[1] ?? '' : dependency;
    const scope = dependency.startsWith('@') ? dependency.slice(1).split('/')[0] : '';
    const lowerTool = tool.toLowerCase();
    // `tailwind` → `tailwindcss` (the name continues), but not `eslint` → `eslint-plugin-x` (a separate package that
    // happens to share the prefix; those are matched by the short-name rule instead).
    const continuesName = unscoped.startsWith(lowerTool) && !/^[-_.]/.test(unscoped.slice(lowerTool.length));
    return unscoped === lowerTool || continuesName || scope === lowerTool;
}

function quotedTokens(text: string): Set<string> {
    const tokens = new Set<string>();
    for (const match of text.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.){1,200})\1|(?:^|[\s{,])([@\w][\w./@-]*)\s*:/gm)) {
        const value = match[2] ?? match[3];
        if (value) tokens.add(value);
    }
    return tokens;
}

function addIfDeclared(token: string, declared: Set<string>, used: Set<string>): void {
    if (!isBareSpecifier(token)) return;
    const name = packageNameFromSpecifier(token);
    if (declared.has(name)) used.add(name);
}

interface LockedPackage {
    peerDependencies: string[];
    bin: Record<string, string> | boolean;
}

const lockCache = new Map<string, Map<string, LockedPackage> | null>();

function packageNameFromLockKey(key: string): string {
    let cleaned = key.replace(/^['"]|['"]$/g, '').replace(/^\//, '');
    const peerSuffix = cleaned.indexOf('(');
    if (peerSuffix > 0) cleaned = cleaned.slice(0, peerSuffix);
    // pnpm v9+: name@version. pnpm <=8: name/version (scoped: @scope/name/version).
    const at = cleaned.lastIndexOf('@');
    if (at > 0) return cleaned.slice(0, at);
    const parts = cleaned.split('/');
    return cleaned.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function parsePackageLock(text: string): Map<string, LockedPackage> | null {
    try {
        const lock = JSON.parse(text) as { packages?: Record<string, { peerDependencies?: Record<string, string>; bin?: Record<string, string> | string }> };
        if (!lock.packages) return null;
        const index = new Map<string, LockedPackage>();
        for (const [key, entry] of Object.entries(lock.packages)) {
            const marker = key.lastIndexOf('node_modules/');
            if (marker < 0) continue;
            const name = key.slice(marker + 'node_modules/'.length);
            if (!index.has(name)) {
                index.set(name, {
                    peerDependencies: Object.keys(entry.peerDependencies ?? {}),
                    bin: typeof entry.bin === 'string' ? { [name.startsWith('@') ? name.split('/')[1] : name]: entry.bin } : (entry.bin ?? false)
                });
            }
        }
        return index;
    } catch {
        return null;
    }
}

/** Minimal line-based reader for the `packages:` section of pnpm-lock.yaml (no YAML dependency needed). */
function parsePnpmLock(text: string): Map<string, LockedPackage> | null {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((line) => line === 'packages:');
    if (start < 0) return null;
    const index = new Map<string, LockedPackage>();
    let current: LockedPackage | null = null;
    let inPeers = false;

    for (let i = start + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (/^\S/.test(line)) break;
        const entry = /^ {2}(\S.*?):\s*$/.exec(line);
        if (entry) {
            const name = packageNameFromLockKey(entry[1]);
            current = index.get(name) ?? { peerDependencies: [], bin: false };
            index.set(name, current);
            inPeers = false;
            continue;
        }
        if (!current) continue;
        if (/^ {4}hasBin:\s*true/.test(line)) current.bin = true;
        if (/^ {4}peerDependencies:\s*$/.test(line)) { inPeers = true; continue; }
        if (/^ {4}\S/.test(line)) { inPeers = false; continue; }
        const peer = inPeers ? /^ {6}(['"]?)(\S+?)\1:/.exec(line) : null;
        if (peer && !current.peerDependencies.includes(peer[2])) current.peerDependencies.push(peer[2]);
    }
    return index;
}

function lockIndexFor(root: string): Map<string, LockedPackage> | null {
    for (const [file, parse] of [['package-lock.json', parsePackageLock], ['npm-shrinkwrap.json', parsePackageLock], ['pnpm-lock.yaml', parsePnpmLock]] as const) {
        const lockPath = path.join(root, file);
        if (lockCache.has(lockPath)) {
            const cached = lockCache.get(lockPath);
            if (cached) return cached;
            continue;
        }
        const text = readFileSafe(lockPath);
        const index = text ? parse(text) : null;
        lockCache.set(lockPath, index);
        if (index) return index;
    }
    return null;
}

/**
 * The package's manifest, from node_modules when installed and otherwise from the lockfile, which records the same
 * peer-dependency and executable facts. CI checkouts and fresh clones have a lockfile but no node_modules.
 */
function readManifest(searchRoots: string[], name: string): Record<string, unknown> | null {
    for (const base of searchRoots) {
        const text = readFileSafe(path.join(base, 'node_modules', name, 'package.json'));
        if (!text) continue;
        try {
            return JSON.parse(text) as Record<string, unknown>;
        } catch {
            // A corrupt manifest tells us nothing; try the next location.
        }
    }
    for (const base of searchRoots) {
        const locked = lockIndexFor(base)?.get(name);
        if (locked) {
            return {
                name,
                peerDependencies: Object.fromEntries(locked.peerDependencies.map((peer) => [peer, '*'])),
                ...(locked.bin ? { bin: locked.bin } : {})
            };
        }
    }
    return null;
}

/**
 * Executables that differ from the package name, for when `node_modules` and the lockfile cannot say (a fresh
 * checkout). Without this, `typescript` looks unused in a repo whose scripts only ever call `tsc`.
 */
const KNOWN_COMMANDS: Record<string, string[]> = {
    typescript: ['tsc', 'tsserver'],
    '@biomejs/biome': ['biome'],
    vitest: ['vitest'],
    eslint: ['eslint'],
    prettier: ['prettier'],
    tsx: ['tsx'],
    tsup: ['tsup'],
    turbo: ['turbo'],
    rimraf: ['rimraf'],
    'ts-node': ['ts-node', 'ts-node-esm'],
    jest: ['jest'],
    mocha: ['mocha'],
    nodemon: ['nodemon'],
    concurrently: ['concurrently'],
    'cross-env': ['cross-env', 'cross-env-shell'],
    'npm-run-all': ['npm-run-all', 'run-s', 'run-p'],
    'npm-run-all2': ['npm-run-all', 'run-s', 'run-p'],
    'lint-staged': ['lint-staged'],
    husky: ['husky'],
    webpack: ['webpack'],
    'webpack-cli': ['webpack'],
    'webpack-dev-server': ['webpack-dev-server', 'webpack serve'],
    rollup: ['rollup'],
    esbuild: ['esbuild'],
    vite: ['vite'],
    '@playwright/test': ['playwright'],
    '@changesets/cli': ['changeset'],
    '@angular/cli': ['ng'],
    '@nestjs/cli': ['nest'],
    '@vue/cli-service': ['vue-cli-service'],
    '@storybook/cli': ['storybook', 'sb'],
    'postcss-cli': ['postcss'],
    'sass-embedded': ['sass'],
    'tailwindcss': ['tailwindcss'],
    'drizzle-kit': ['drizzle-kit'],
    'drizzle-orm': [],
    prisma: ['prisma'],
    knip: ['knip'],
    madge: ['madge'],
    typedoc: ['typedoc'],
    stylelint: ['stylelint'],
    nx: ['nx'],
    lerna: ['lerna'],
    wrangler: ['wrangler'],
    vercel: ['vercel'],
    'wait-on': ['wait-on'],
    'http-server': ['http-server'],
    serve: ['serve'],
    'ts-jest': [],
    'size-limit': ['size-limit'],
    'tsc-alias': ['tsc-alias'],
    'ts-patch': ['tspc', 'ts-patch']
};

/** Executable names a package installs, from its manifest's `bin` field (a bare string means "named after the package"). */
export function binNamesOf(searchRoots: string[], name: string): string[] {
    const manifest = readManifest(searchRoots, name);
    // Not installed (CI checkouts, fresh clones): the manifest can't say, so assume the common convention that
    // the executable is named after the package (`@biomejs/biome` → `biome`, `prettier` → `prettier`).
    if (!manifest) {
        const unscoped = name.startsWith('@') ? name.split('/')[1] ?? '' : name;
        const conventional = unscoped ? [unscoped, unscoped.replace(/-cli$/, '')] : [];
        return [...(KNOWN_COMMANDS[name] ?? []), ...conventional].filter((candidate, index, all) => candidate.length >= 3 && all.indexOf(candidate) === index);
    }
    const bin = manifest.bin;
    if (!bin) return [];
    if (typeof bin === 'string' || bin === true) return [name.startsWith('@') ? name.split('/')[1] : name];
    return Object.keys(bin as Record<string, string>);
}

export interface DependencyUsageInput {
    declared: Set<string>;
    packageRoot: string;
    projectRoot: string;
    packageJson: Record<string, unknown> | null;
    /** Files (absolute) that belong to this package: config files and text files such as stylesheets. */
    candidateFiles: string[];
    /** Packages already known to be used through imports/scripts. */
    usedViaImports: Set<string>;
    /** JS/TS source files of this package: a package named in a string (`engine = 'hbs'`) is loaded by name at runtime. */
    sourceFiles?: string[];
    /** Text that invokes installed executables: package scripts plus CI / hook / lint-staged style configuration. */
    commandText?: string;
}

export function collectNonImportUsage(input: DependencyUsageInput): Set<string> {
    const { declared, packageRoot, projectRoot, packageJson, candidateFiles } = input;
    const used = new Set<string>();

    // Tokens seen in each tool's own configuration, so a shorthand like "next/core-web-vitals" can be matched
    // back to `eslint-config-next` (tool = eslint).
    const tokensByTool = new Map<string, Set<string>>();
    const rememberTokens = (tool: string | undefined, tokens: Iterable<string>): void => {
        if (!tool) return;
        const key = tool.toLowerCase().replace(/(?:config|rc)$/, '');
        const set = tokensByTool.get(key) ?? new Set<string>();
        for (const token of tokens) set.add(token);
        tokensByTool.set(key, set);
    };
    const wordTokens = (text: string): Set<string> => new Set(text.match(/[@\w][\w./@-]*/g) ?? []);

    for (const file of candidateFiles) {
        const base = path.basename(file);

        if (STYLE_FILE.test(base)) {
            for (const match of readFileSafe(file).matchAll(STYLE_IMPORT)) addIfDeclared(match[1], declared, used);
            continue;
        }

        const isToolConfig = TOOL_CONFIG_FILE.test(base);
        const isDataConfig = DATA_CONFIG_FILE.test(base) && !NEVER_CONFIG_DATA.test(base);
        if (!isToolConfig && !isDataConfig) continue;

        // The config file's existence implies its tool (postcss.config.js → postcss).
        const tool = base.match(TOOL_CONFIG_BASENAME)?.[1];
        if (tool && (isToolConfig || (isDataConfig && /^\.?[a-z][\w-]*(?:rc)?\.(?:jsonc?|ya?ml|toml)$|^\.[a-z][\w-]*rc$/i.test(base)))) {
            for (const dependency of declared) if (packageMatchesTool(dependency, tool)) used.add(dependency);
        }

        const text = readFileSafe(file);
        if (!text || text.length > MAX_CONFIG_BYTES) continue;
        // JS configs list plugins as quoted strings/keys; data files (YAML lists, TOML) also use bare words.
        const tokens = isDataConfig ? wordTokens(text) : quotedTokens(text);
        for (const token of tokens) addIfDeclared(token, declared, used);
        rememberTokens(tool, isDataConfig ? tokens : wordTokens(text));
    }

    if (packageJson) {
        const configFields = Object.fromEntries(Object.entries(packageJson).filter(([key]) => !STANDARD_PACKAGE_FIELDS.has(key)));
        for (const [key, value] of Object.entries(configFields)) {
            for (const dependency of declared) if (packageMatchesTool(dependency, key)) used.add(dependency);
            rememberTokens(key, wordTokens(JSON.stringify(value)));
        }
        for (const token of quotedTokens(JSON.stringify(configFields))) addIfDeclared(token, declared, used);
    }

    // Short names: `"extends": ["next/core-web-vitals", "prettier"]` in an eslint config uses eslint-config-next
    // and eslint-config-prettier. The tool prefix in the package name says whose config to look in.
    for (const dependency of declared) {
        if (used.has(dependency)) continue;
        const convention = TOOL_PACKAGE_CONVENTION.exec(dependency);
        if (!convention) continue;
        const [, scope, tool, rest] = convention;
        const tokens = tokensByTool.get(tool);
        if (!tokens) continue;
        // `eslint-plugin-react` is "react"; `@stylistic/eslint-plugin` is the "@stylistic" namespace (`@stylistic/indent`).
        const shortNames = rest ? [rest, scope ? `@${scope}/${rest}` : ''].filter(Boolean) : scope ? [`@${scope}`] : [];
        if (shortNames.length === 0) continue;
        const referenced = [...tokens].some((token) => shortNames.some((short) => token === short || token.startsWith(`${short}/`) || token === `plugin:${short}`));
        if (referenced) used.add(dependency);
    }

    // Packages loaded by name at runtime: `app.set('view engine', 'hbs')`, `require(variable)` against a literal, plugin lists.
    const unresolved = [...declared].filter((name) => !used.has(name) && !input.usedViaImports.has(name) && !name.startsWith('@types/'));
    if (unresolved.length > 0) {
        for (const file of input.sourceFiles ?? []) {
            if (unresolved.every((name) => used.has(name))) break;
            const text = readFileSafe(file);
            for (const name of unresolved) {
                if (used.has(name)) continue;
                if (text.includes(`'${name}`) || text.includes(`"${name}`) || text.includes(`\`${name}`)) {
                    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    if (new RegExp(`(["'\`])${escaped}(?:/[^"'\`]*)?\\1`).test(text)) used.add(name);
                }
            }
        }
    }

    // Tools are often invoked by an executable name that differs from the package name:
    // @biomejs/biome → `biome`, typescript → `tsc`. The installed manifest's `bin` field says which names to look for.
    if (input.commandText) {
        const searchRootsForBin = [...new Set([packageRoot, projectRoot])];
        for (const name of declared) {
            if (used.has(name) || input.usedViaImports.has(name)) continue;
            for (const binName of binNamesOf(searchRootsForBin, name)) {
                const escaped = binName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                if (new RegExp(`(^|[\\s;&|(=/"'\`,\\[])${escaped}(?=[\\s;&|)"'\`]|$)`).test(input.commandText)) {
                    used.add(name);
                    break;
                }
            }
        }
    }

    // Peer dependencies of anything in use are required by that package at runtime, transitively
    // (autoprefixer → postcss, next → react-dom, @next/mdx → @mdx-js/loader).
    const searchRoots = [...new Set([packageRoot, projectRoot])];
    const queue = [...new Set([...input.usedViaImports, ...used])];
    const seen = new Set(queue);
    while (queue.length > 0) {
        const name = queue.pop()!;
        const manifest = readManifest(searchRoots, name);
        const peers = Object.keys((manifest?.peerDependencies as Record<string, string> | undefined) ?? {});
        for (const peer of peers) {
            if (declared.has(peer)) used.add(peer);
            if (!seen.has(peer)) {
                seen.add(peer);
                queue.push(peer);
            }
        }
    }

    return used;
}

/** Facts about an unused-looking dependency that lower our confidence that removing it is safe. */
export interface DependencyRisk {
    hasBin: boolean;
    mentionedIn: string | null;
    /** Whether the package is installed, i.e. whether peer/bin evidence could be checked at all. */
    installed: boolean;
}

export function assessRemovalRisk(
    name: string,
    searchRoots: string[],
    mentionCandidates: string[],
    projectRoot: string
): DependencyRisk {
    const manifest = readManifest(searchRoots, name);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mention = new RegExp(`(^|[^A-Za-z0-9_@/.-])${escaped}([^A-Za-z0-9_@.-]|$)`);

    let mentionedIn: string | null = null;
    for (const file of mentionCandidates) {
        if (mention.test(readFileSafe(file))) {
            mentionedIn = path.relative(projectRoot, file).replace(/\\/g, '/');
            break;
        }
    }

    return { hasBin: !!manifest?.bin, mentionedIn, installed: manifest !== null };
}
