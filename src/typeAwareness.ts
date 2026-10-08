import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** Rules whose verdict comes from the type checker, and so is only as good as the types it could load. */
export const TYPE_AWARE_RULES = new Set(['TS001', 'ERR003']);

const UNRESOLVED_MODULE = 2307;
const MIN_UNRESOLVED = 10;
const UNRESOLVED_SHARE = 0.5;

export interface TypeAwareness {
    degraded: boolean;
    /** Package specifiers the compiler could not resolve (sorted), whether or not that degrades type-based findings. */
    unresolved: string[];
    /** Distinct package specifiers imported by the analyzed files. */
    importedPackages: number;
    /** One-line explanation for the scan banner. */
    reason?: string;
}

function declaresDependencies(packageJson: Record<string, unknown> | null): boolean {
    return ['dependencies', 'devDependencies', 'peerDependencies'].some((field) => Object.keys((packageJson?.[field] as object | undefined) ?? {}).length > 0);
}

/**
 * Whether the type checker could see the project's dependencies. Without `node_modules` every imported
 * type is `any`, so implicit-any and "is this a Promise?" answers are guesses: findings that depend on
 * them are reported with low confidence instead of as fact.
 */
export function assessTypeAwareness(projectRoot: string, packageJson: Record<string, unknown> | null, program: ts.Program, files: string[]): TypeAwareness {
    const unresolvedSet = new Set<string>();
    const imported = new Set<string>();
    for (const file of files) {
        const sourceFile = program.getSourceFile(file);
        if (!sourceFile) continue;
        for (const diagnostic of program.getSemanticDiagnostics(sourceFile)) {
            if (diagnostic.code !== UNRESOLVED_MODULE) continue;
            const specifier = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').match(/module '([^']+)'/)?.[1];
            if (specifier && !specifier.startsWith('.') && !specifier.startsWith('/')) unresolvedSet.add(specifier);
        }
        for (const statement of sourceFile.statements) {
            if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
                const specifier = statement.moduleSpecifier.text;
                if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:')) imported.add(specifier);
            }
        }
    }
    const unresolved = [...unresolvedSet].sort();
    const base = { unresolved, importedPackages: imported.size };

    if (!fs.existsSync(path.join(projectRoot, 'node_modules')) && declaresDependencies(packageJson)) {
        return { ...base, degraded: true, reason: 'Dependencies are not installed (no node_modules), so imported types are unknown. Type-based findings (TS001, ERR003) are reported at low confidence. Run your package manager\'s install for accurate results.' };
    }
    if (unresolved.length >= MIN_UNRESOLVED && unresolved.length / Math.max(imported.size, 1) >= UNRESOLVED_SHARE) {
        return { ...base, degraded: true, reason: `${unresolved.length} of ${imported.size} imported packages could not be resolved, so their types are unknown. Type-based findings (TS001, ERR003) are reported at low confidence.` };
    }
    return { ...base, degraded: false };
}
