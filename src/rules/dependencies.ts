import { builtinModules } from 'node:module';
import path from 'node:path';
import type { RuleContext } from '../context';
import type { Finding } from '../types';
import { buildFinding } from '../finding';
import { isRuleEnabled } from '../config';
import { readFileSafe } from '../discovery';
import { findImportCycles } from '../moduleGraph';
import { loadTsConfigFor } from '../moduleResolution';
import { classifyFile } from '../fileKind';
import { loadBundlerAliases } from '../bundlerAliases';
import { isFrameworkVirtualModule } from '../frameworkConventions';
import { assessRemovalRisk, collectNonImportUsage, looksLikeToolExtension, packageNameFromSpecifier } from '../dependencyUsage';

/** Files that run installed executables by name: CI workflows, git hooks, Makefiles, Dockerfiles, shell scripts. */
const COMMAND_FILE = /(?:^|\/)(?:\.github\/|\.husky\/|\.gitlab-ci|Makefile$|Dockerfile|Justfile$|[^/]*\.(?:ya?ml|sh|toml)$)/i;

const BUILTIN_MODULES = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

interface WorkspacePackage {
    root: string;
    relativePath: string;
    name: string | null;
    text: string;
    declared: Set<string>;
    scriptText: string;
}

/**
 * Specifiers that never name an npm package: URL-style schemes (`node:`, `bun:`, `jsr:`, `npm:`, `https:`),
 * Node subpath imports (`#internal/x`) and absolute paths.
 */
function isNonPackageSpecifier(specifier: string): boolean {
    return /^[a-z][a-z0-9+.-]*:/i.test(specifier) || specifier.startsWith('#') || specifier.startsWith('/');
}

/** Bare specifiers an import map (Deno, browsers) resolves itself, e.g. `"@std/assert": "jsr:@std/assert@1"`. */
function loadImportMapSpecifiers(projectRoot: string): Set<string> {
    const names = new Set<string>();
    for (const file of ['deno.json', 'deno.jsonc', 'import_map.json', 'importmap.json']) {
        const text = readFileSafe(path.join(projectRoot, file));
        if (!text) continue;
        try {
            const parsed = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as { imports?: Record<string, string> };
            for (const key of Object.keys(parsed.imports ?? {})) names.add(key.replace(/\/$/, ''));
        } catch {
            // Not valid JSON (JSONC with trailing commas, say): ignore rather than guess.
        }
    }
    return names;
}

/** `mdx` → `@types/mdx`, `@scope/name` → `@types/scope__name` (DefinitelyTyped naming). */
function typesPackageFor(name: string): string {
    return name.startsWith('@') ? `@types/${name.slice(1).replace('/', '__')}` : `@types/${name}`;
}

function findDependencyLine(packageJsonText: string, dependencyName: string): number {
    const escaped = dependencyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`"${escaped}"\\s*:`);
    const lines = packageJsonText.split(/\r\n|\r|\n/);

    for (let i = 0; i < lines.length; i += 1) {
        if (pattern.test(lines[i])) {
            return i + 1;
        }
    }

    return 1;
}

function getDeclaredDependencyNames(packageJson: Record<string, unknown> | null): Set<string> {
    if (!packageJson) return new Set();

    const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    const names = new Set<string>();
    for (const field of fields) {
        const section = packageJson[field] as Record<string, string> | undefined;
        if (section) {
            for (const name of Object.keys(section)) {
                names.add(name);
            }
        }
    }
    return names;
}

/**
 * Every package.json in the project (root plus any workspace members), so dependency checks run
 * against the package that actually declares them instead of only the root. Parse failures are
 * skipped rather than treated as "declares nothing", which would flood a workspace with false
 * unlisted-dependency findings.
 */
function discoverWorkspacePackages(context: RuleContext): WorkspacePackage[] {
    const packages: WorkspacePackage[] = [];
    const seenRoots = new Set<string>();

    const addPackage = (absolutePath: string, json: Record<string, unknown> | null, text: string): void => {
        const root = path.dirname(absolutePath);
        if (seenRoots.has(root)) return;
        seenRoots.add(root);
        const scripts = (json?.scripts as Record<string, string> | undefined) ?? {};
        packages.push({
            root,
            relativePath: path.relative(context.projectRoot, absolutePath).replace(/\\/g, '/') || 'package.json',
            name: typeof json?.name === 'string' ? json.name : null,
            text,
            declared: getDeclaredDependencyNames(json),
            scriptText: Object.values(scripts).join(' ')
        });
    };

    const rootPackageJsonPath = path.join(context.projectRoot, 'package.json');
    addPackage(rootPackageJsonPath, context.packageJson, readFileSafe(rootPackageJsonPath));

    for (const file of context.allFiles) {
        if (path.basename(file) !== 'package.json' || path.resolve(file) === path.resolve(rootPackageJsonPath)) continue;
        const text = readFileSafe(file);
        try {
            addPackage(file, JSON.parse(text), text);
        } catch {
            // Malformed package.json: skip it rather than treating it as declaring nothing.
        }
    }

    return packages.sort((a, b) => b.root.length - a.root.length);
}

/** The package whose directory most closely contains `absoluteFile` (longest matching root). */
function nearestPackage(absoluteFile: string, packagesByRootLengthDesc: WorkspacePackage[]): WorkspacePackage {
    const fileDir = path.dirname(absoluteFile);
    for (const pkg of packagesByRootLengthDesc) {
        const relative = path.relative(pkg.root, fileDir);
        if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
            return pkg;
        }
    }
    return packagesByRootLengthDesc[packagesByRootLengthDesc.length - 1];
}

export function runDependencyRules(context: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const { moduleGraph, projectRoot } = context;

    const packages = discoverWorkspacePackages(context);
    const isWorkspace = packages.length > 1;
    const root = packages.reduce((longestRootPkg, pkg) => (pkg.root.length < longestRootPkg.root.length ? pkg : longestRootPkg));

    // Assign every file to its owning package exactly once. Doing this per package (packages x files x
    // packages path comparisons) made large workspaces, which can have hundreds of package.json files, take minutes.
    const ownerCache = new Map<string, WorkspacePackage>();
    const ownerOf = (file: string): WorkspacePackage => {
        let owner = ownerCache.get(file);
        if (!owner) {
            owner = nearestPackage(file, packages);
            ownerCache.set(file, owner);
        }
        return owner;
    };
    // Usage grouped by the nearest package.json, plus a project-wide union: a dependency hoisted to
    // the workspace root can legitimately be used by any member package without being redeclared there.
    const usedByPackageRoot = new Map<string, Set<string>>();
    const usedAnywhere = new Set<string>();

    for (const [file, imports] of moduleGraph.importsByFile) {
        const pkg = ownerOf(file);
        for (const importInfo of imports) {
            // A resolved bare import (workspace sibling, tsconfig path) still proves its package name is in use.
            if (importInfo.isRelative) continue;
            const name = packageNameFromSpecifier(importInfo.specifier);
            usedAnywhere.add(name);
            if (!usedByPackageRoot.has(pkg.root)) usedByPackageRoot.set(pkg.root, new Set());
            usedByPackageRoot.get(pkg.root)!.add(name);
        }
    }

    const groupByOwner = (files: string[]): Map<WorkspacePackage, string[]> => {
        const groups = new Map<WorkspacePackage, string[]>();
        for (const file of files) {
            const owner = ownerOf(file);
            const list = groups.get(owner);
            if (list) list.push(file);
            else groups.set(owner, [file]);
        }
        return groups;
    };

    if (isRuleEnabled(context.config, 'DEP001')) {
        const allFilesByOwner = groupByOwner([...context.allFiles, ...context.textFiles]);
        const sourceFilesByOwner = groupByOwner(context.files);
        const textFilesByOwner = groupByOwner(context.textFiles);

        for (const pkg of packages) {
            // Packages inside playgrounds, examples, benchmarks and fixtures are test inputs: their dependencies exist to be
            // resolved by the thing under test, not imported by code.
            if (['example', 'fixture', 'benchmark', 'test'].includes(classifyFile(pkg.relativePath))) continue;
            // The root's dependencies may be consumed by any workspace member; a nested package's
            // own dependencies are expected to be used within that package.
            const used = pkg === root ? usedAnywhere : (usedByPackageRoot.get(pkg.root) ?? new Set());
            const scriptText = isWorkspace && pkg !== root ? `${pkg.scriptText} ${root.scriptText}` : pkg.scriptText;

            const packageFiles = allFilesByOwner.get(pkg) ?? [];
            const packageTextFiles = textFilesByOwner.get(pkg) ?? [];
            const searchRoots = [...new Set([pkg.root, projectRoot])];
            const commandText = [
                scriptText,
                ...(pkg === root ? [JSON.stringify(Object.fromEntries(Object.entries(context.packageJson ?? {}).filter(([key]) => !['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].includes(key))))] : []),
                ...packageTextFiles.filter((file) => COMMAND_FILE.test(path.relative(projectRoot, file).replace(/\\/g, '/'))).map((file) => readFileSafe(file))
            ].join('\n');
            const sourceFiles = sourceFilesByOwner.get(pkg) ?? [];
            const usedElsewhere = collectNonImportUsage({
                declared: pkg.declared,
                packageRoot: pkg.root,
                projectRoot,
                packageJson: pkg === root ? context.packageJson : null,
                candidateFiles: packageFiles,
                usedViaImports: used,
                sourceFiles,
                commandText
            });
            // Compiler options that pull in a package without any import: `importHelpers` loads tslib, `jsxImportSource` the JSX runtime.
            const tsOptions = loadTsConfigFor(pkg.root)?.options;
            // The Angular CLI turns on importHelpers for every build, so an Angular project needs tslib whatever its tsconfig says.
            if (tsOptions?.importHelpers || [...pkg.declared].some((name) => name.startsWith('@angular/'))) usedElsewhere.add('tslib');
            if (tsOptions?.jsxImportSource) usedElsewhere.add(packageNameFromSpecifier(tsOptions.jsxImportSource));
            const mentionCandidates = packageTextFiles.filter((file) => path.basename(file) !== 'package.json' && !/\.(?:md|mdx|markdown|rst|txt|adoc)$/i.test(file));

            for (const dependencyName of pkg.declared) {
                if (used.has(dependencyName) || usedElsewhere.has(dependencyName)) continue;

                // @types/* packages provide ambient global declarations (process, Buffer, JSX, ...)
                // that are never referenced through an import specifier, so they are exempt by design.
                if (dependencyName.startsWith('@types/')) continue;

                const wordBoundary = new RegExp(`(^|[^A-Za-z0-9_@/.-])${dependencyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_@/.-]|$)`);
                if (wordBoundary.test(scriptText)) continue;

                // Absence from the import graph proves little for packages that tools load by name or
                // that ship executables, so lower confidence and keep them out of the safe-fix set.
                const risk = assessRemovalRisk(dependencyName, searchRoots, mentionCandidates, projectRoot);
                const isExtension = looksLikeToolExtension(dependencyName);
                const confidence = risk.mentionedIn ? 'LOW' : (risk.hasBin || !risk.installed || isExtension) ? 'MEDIUM' : 'HIGH';
                const caveat = risk.mentionedIn
                    ? ` The name also appears in ${risk.mentionedIn}, so a tool may load it by name.`
                    : !risk.installed
                        ? ' The package is not installed here, so its peer dependencies and executables could not be checked.'
                        : isExtension ? ' It looks like a plugin, preset or parser, which the tool it extends loads by name rather than through an import.'
                        : risk.hasBin ? ' It provides an executable that a tool or CI step may invoke.' : '';

                findings.push(
                    buildFinding({
                        ruleId: 'DEP001',
                        category: 'dependencies',
                        severity: 'MEDIUM',
                        confidence,
                        file: pkg.relativePath,
                        line: findDependencyLine(pkg.text, dependencyName),
                        column: 1,
                        message: `Unused dependency: ${dependencyName}`,
                        description: `"${dependencyName}" is declared in ${pkg.relativePath} but not referenced by source files, config files, stylesheets, package.json scripts, or the peer dependencies of installed packages.${caveat}`,
                        evidence: dependencyName,
                        suggestion: 'Remove the unused dependency or confirm it is required by a toolchain entry point.',
                        fixAvailable: confidence === 'HIGH'
                    })
                );
            }
        }
    }

    if (isRuleEnabled(context.config, 'DEP002')) {
        const reported = new Set<string>();
        const workspaceNames = new Set(packages.map((pkg) => pkg.name).filter((name): name is string => !!name));
        const mappedSpecifiers = loadImportMapSpecifiers(projectRoot);
        const isBundlerAlias = loadBundlerAliases(projectRoot, [...context.allFiles, ...context.textFiles]);
        for (const [file, imports] of moduleGraph.importsByFile) {
            const pkg = ownerOf(file);
            // Examples, benchmarks and fixtures are self-contained snippets with their own (or no) manifest.
            if (['example', 'benchmark', 'fixture'].includes(classifyFile(path.relative(projectRoot, file)))) continue;
            // Tolerate hoisting: a nested package may use a dependency declared only at the workspace root.
            const declared = pkg === root ? pkg.declared : new Set([...pkg.declared, ...root.declared]);

            for (const importInfo of imports) {
                if (importInfo.isRelative || importInfo.resolved) continue;
                const usedName = packageNameFromSpecifier(importInfo.specifier);
                if (isNonPackageSpecifier(importInfo.specifier) || importInfo.isPathAlias || mappedSpecifiers.has(usedName) || mappedSpecifiers.has(importInfo.specifier)) continue;
                if (isBundlerAlias(importInfo.specifier) || isFrameworkVirtualModule(importInfo.specifier, declared)) continue;
                // A package may import itself by name, and workspace siblings are linked rather than installed.
                if (workspaceNames.has(usedName)) continue;
                // `import type { X } from 'mdx/types'` is typed by @types/mdx, which is the package that is declared.
                if (BUILTIN_MODULES.has(usedName) || declared.has(usedName) || declared.has(typesPackageFor(usedName))) continue;

                const key = `${pkg.root}::${usedName}`;
                if (reported.has(key)) continue;
                reported.add(key);

                findings.push(
                    buildFinding({
                        ruleId: 'DEP002',
                        category: 'dependencies',
                        severity: 'HIGH',
                        confidence: 'HIGH',
                        file: pkg.relativePath,
                        line: 1,
                        column: 1,
                        message: `Unlisted dependency: ${usedName}`,
                        description: `"${usedName}" is imported from source under ${path.relative(projectRoot, pkg.root).replace(/\\/g, '/') || '.'} but is not declared in ${pkg.relativePath}${isWorkspace ? ' or the workspace root' : ''}.`,
                        evidence: usedName,
                        suggestion: 'Add the package to the appropriate package.json dependencies, or remove the import if it was unintentional.',
                        fixAvailable: false
                    })
                );
            }
        }
    }

    if (isRuleEnabled(context.config, 'DEP003')) {
        const cycles = findImportCycles(moduleGraph);
        const reported = new Set<string>();

        for (const cycle of cycles) {
            const relativeCycle = cycle.map((file) => path.relative(projectRoot, file).replace(/\\/g, '/'));
            const key = [...relativeCycle].sort().join('|');
            if (reported.has(key)) continue;
            reported.add(key);

            // The line where each file pulls in the next one, so the chain can be followed in an editor.
            const hops = cycle.slice(0, -1).map((file, index) => {
                const target = cycle[index + 1];
                const hop = moduleGraph.importsByFile.get(file)?.find((info) => info.resolved === target && !info.isTypeOnly);
                return `${relativeCycle[index]}:${hop?.line ?? 1}`;
            });
            const chain = [...hops, relativeCycle[relativeCycle.length - 1]].join(' → ');
            const firstLine = Number(hops[0].slice(hops[0].lastIndexOf(':') + 1)) || 1;

            findings.push(
                buildFinding({
                    ruleId: 'DEP003',
                    category: 'dependencies',
                    severity: 'MEDIUM',
                    confidence: 'HIGH',
                    file: relativeCycle[0],
                    line: firstLine,
                    column: 1,
                    message: 'Circular import detected',
                    description: `A cycle exists in the internal module import graph: ${chain}`,
                    evidence: relativeCycle.join(' -> '),
                    suggestion: 'Break the cycle by extracting shared code into a separate module.',
                    fixAvailable: false
                })
            );
        }
    }

    return findings;
}
