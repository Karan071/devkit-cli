import { builtinModules } from 'node:module';
import path from 'node:path';
import type { RuleContext } from '../context';
import type { Finding } from '../types';
import { buildFinding } from '../finding';
import { isRuleEnabled } from '../config';
import { readFileSafe } from '../discovery';
import { findImportCycles } from '../moduleGraph';

const BUILTIN_MODULES = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

interface WorkspacePackage {
    root: string;
    relativePath: string;
    text: string;
    declared: Set<string>;
    scriptText: string;
}

function packageNameFromSpecifier(specifier: string): string {
    if (specifier.startsWith('@')) {
        const parts = specifier.split('/');
        return parts.slice(0, 2).join('/');
    }
    return specifier.split('/')[0];
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

    // Usage grouped by the nearest package.json, plus a project-wide union: a dependency hoisted to
    // the workspace root can legitimately be used by any member package without being redeclared there.
    const usedByPackageRoot = new Map<string, Set<string>>();
    const usedAnywhere = new Set<string>();

    for (const [file, imports] of moduleGraph.importsByFile) {
        const pkg = nearestPackage(file, packages);
        for (const importInfo of imports) {
            if (importInfo.isRelative || importInfo.resolved) continue;
            const name = packageNameFromSpecifier(importInfo.specifier);
            usedAnywhere.add(name);
            if (!usedByPackageRoot.has(pkg.root)) usedByPackageRoot.set(pkg.root, new Set());
            usedByPackageRoot.get(pkg.root)!.add(name);
        }
    }

    if (isRuleEnabled(context.config, 'DEP001')) {
        for (const pkg of packages) {
            // The root's dependencies may be consumed by any workspace member; a nested package's
            // own dependencies are expected to be used within that package.
            const used = pkg === root ? usedAnywhere : (usedByPackageRoot.get(pkg.root) ?? new Set());
            const scriptText = isWorkspace && pkg !== root ? `${pkg.scriptText} ${root.scriptText}` : pkg.scriptText;

            for (const dependencyName of pkg.declared) {
                if (used.has(dependencyName)) continue;

                // @types/* packages provide ambient global declarations (process, Buffer, JSX, ...)
                // that are never referenced through an import specifier, so they are exempt by design.
                if (dependencyName.startsWith('@types/')) continue;

                const wordBoundary = new RegExp(`(^|[^A-Za-z0-9_@/.-])${dependencyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_@/.-]|$)`);
                if (wordBoundary.test(scriptText)) continue;

                findings.push(
                    buildFinding({
                        ruleId: 'DEP001',
                        category: 'dependencies',
                        severity: 'MEDIUM',
                        confidence: 'CERTAIN',
                        file: pkg.relativePath,
                        line: findDependencyLine(pkg.text, dependencyName),
                        column: 1,
                        message: `Unused dependency: ${dependencyName}`,
                        description: `"${dependencyName}" is declared in ${pkg.relativePath} but not referenced by source files, require/import calls, or package.json scripts.`,
                        evidence: dependencyName,
                        suggestion: 'Remove the unused dependency or confirm it is required by a toolchain entry point.',
                        fixAvailable: true
                    })
                );
            }
        }
    }

    if (isRuleEnabled(context.config, 'DEP002')) {
        const reported = new Set<string>();
        for (const [file, imports] of moduleGraph.importsByFile) {
            const pkg = nearestPackage(file, packages);
            // Tolerate hoisting: a nested package may use a dependency declared only at the workspace root.
            const declared = pkg === root ? pkg.declared : new Set([...pkg.declared, ...root.declared]);

            for (const importInfo of imports) {
                if (importInfo.isRelative || importInfo.resolved) continue;
                const usedName = packageNameFromSpecifier(importInfo.specifier);
                if (BUILTIN_MODULES.has(usedName) || declared.has(usedName)) continue;

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

            findings.push(
                buildFinding({
                    ruleId: 'DEP003',
                    category: 'dependencies',
                    severity: 'MEDIUM',
                    confidence: 'HIGH',
                    file: relativeCycle[0],
                    line: 1,
                    column: 1,
                    message: 'Circular import detected',
                    description: 'A cycle exists in the internal module import graph.',
                    evidence: relativeCycle.join(' -> '),
                    suggestion: 'Break the cycle by extracting shared code into a separate module.',
                    fixAvailable: false
                })
            );
        }
    }

    return findings;
}
