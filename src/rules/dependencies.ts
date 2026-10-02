import { builtinModules } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import type { RuleContext } from '../context';
import type { Finding } from '../types';
import { buildFinding } from '../finding';
import { isRuleEnabled } from '../config';
import { readFileSafe } from '../discovery';
import { findImportCycles } from '../moduleGraph';

const BUILTIN_MODULES = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

function packageNameFromSpecifier(specifier: string): string {
    if (specifier.startsWith('@')) {
        const parts = specifier.split('/');
        return parts.slice(0, 2).join('/');
    }
    return specifier.split('/')[0];
}

function collectRequireAndDynamicImportSpecifiers(sourceFile: ts.SourceFile): string[] {
    const specifiers: string[] = [];

    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
            const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;

            if ((isRequire || isDynamicImport) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
                specifiers.push(node.arguments[0].text);
            }
        }
        ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return specifiers;
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

export function runDependencyRules(context: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const { moduleGraph, packageJson, projectRoot } = context;

    const usedPackageNames = new Set<string>();

    for (const [, imports] of moduleGraph.importsByFile) {
        for (const importInfo of imports) {
            if (!importInfo.isRelative && !importInfo.resolved) {
                usedPackageNames.add(packageNameFromSpecifier(importInfo.specifier));
            }
        }
    }

    for (const file of context.files) {
        const sourceFile = context.program.getSourceFile(file) ?? ts.createSourceFile(file, readFileSafe(file), ts.ScriptTarget.ES2022, true);
        for (const specifier of collectRequireAndDynamicImportSpecifiers(sourceFile)) {
            if (!specifier.startsWith('.')) {
                usedPackageNames.add(packageNameFromSpecifier(specifier));
            }
        }
    }

    const scripts = (packageJson?.scripts as Record<string, string> | undefined) ?? {};
    const scriptText = Object.values(scripts).join(' ');

    const declaredDependencies = getDeclaredDependencyNames(packageJson);

    if (isRuleEnabled(context.config, 'DEP001')) {
        for (const dependencyName of declaredDependencies) {
            if (usedPackageNames.has(dependencyName)) continue;

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
                    file: 'package.json',
                    line: 1,
                    column: 1,
                    message: 'Unused dependency detected',
                    description: 'A declared package is not referenced by source files, require/import calls, or package.json scripts.',
                    evidence: dependencyName,
                    suggestion: 'Remove the unused dependency or confirm it is required by a toolchain entry point.',
                    fixAvailable: true
                })
            );
        }
    }

    if (isRuleEnabled(context.config, 'DEP002')) {
        for (const usedName of usedPackageNames) {
            if (BUILTIN_MODULES.has(usedName)) continue;
            if (declaredDependencies.has(usedName)) continue;

            findings.push(
                buildFinding({
                    ruleId: 'DEP002',
                    category: 'dependencies',
                    severity: 'HIGH',
                    confidence: 'HIGH',
                    file: 'package.json',
                    line: 1,
                    column: 1,
                    message: 'Unlisted dependency detected',
                    description: 'A module is imported from source but is not declared in package.json.',
                    evidence: usedName,
                    suggestion: 'Add the package to package.json dependencies, or remove the import if it was unintentional.',
                    fixAvailable: false
                })
            );
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
