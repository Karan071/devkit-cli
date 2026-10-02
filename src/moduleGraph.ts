import path from 'node:path';
import ts from 'typescript';
import { SOURCE_EXTENSIONS, isTestFile, readFileSafe } from './discovery';
import { parseSourceFile } from './ast/parse';
import { forEachNode, lineAndColumn } from './ast/walk';
import type { DevkitConfig } from './config';
import { matchesAnyGlob } from './glob';
import { createResolutionContext, resolveSpecifier, type SpecifierKind } from './moduleResolution';

export interface ImportInfo {
    specifier: string;
    resolved: string | null;
    isRelative: boolean;
    namedImports: string[];
    hasDefaultImport: boolean;
    hasNamespaceImport: boolean;
    isSideEffectOnly: boolean;
    line: number;
    kind: SpecifierKind;
}

export interface ExportInfo {
    name: string;
    kind: 'function' | 'class' | 'interface' | 'typeAlias' | 'variable' | 'enum' | 'default' | 'named';
    line: number;
}

export interface ModuleGraph {
    importsByFile: Map<string, ImportInfo[]>;
    exportsByFile: Map<string, ExportInfo[]>;
    edges: Map<string, Set<string>>;
    reverseEdges: Map<string, Set<string>>;
    reExportAllTargets: Map<string, Set<string>>;
    entryPoints: Set<string>;
    fileSet: Set<string>;
    dynamicRequireHints: Set<string>;
}

function extractImportsAndExports(
    file: string,
    projectRoot: string,
    sourceFile: ts.SourceFile,
    fileSet: Set<string>,
    resolutionContext: ReturnType<typeof createResolutionContext>
): { imports: ImportInfo[]; exports: ExportInfo[]; reExportAllTargets: string[]; dynamicRequireHints: string[] } {
    const imports: ImportInfo[] = [];
    const exports: ExportInfo[] = [];
    const reExportAllTargets: string[] = [];
    const dynamicRequireHints: string[] = [];

    const addImport = (
        specifier: string,
        kind: SpecifierKind,
        line: number,
        details: Partial<Pick<ImportInfo, 'namedImports' | 'hasDefaultImport' | 'hasNamespaceImport' | 'isSideEffectOnly'>> = {}
    ): ImportInfo => {
        const info: ImportInfo = {
            specifier,
            resolved: resolveSpecifier(file, specifier, kind, fileSet, resolutionContext),
            isRelative: specifier.startsWith('.'),
            namedImports: details.namedImports ?? [],
            hasDefaultImport: details.hasDefaultImport ?? false,
            hasNamespaceImport: details.hasNamespaceImport ?? false,
            isSideEffectOnly: details.isSideEffectOnly ?? false,
            line,
            kind
        };
        imports.push(info);
        return info;
    };

    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
            const clause = statement.importClause;
            const namedImports: string[] = [];
            let hasDefaultImport = false;
            let hasNamespaceImport = false;
            if (clause) {
                hasDefaultImport = !!clause.name;
                if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) hasNamespaceImport = true;
                else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                    for (const element of clause.namedBindings.elements) namedImports.push((element.propertyName ?? element.name).text);
                }
            }
            addImport(statement.moduleSpecifier.text, 'import', lineAndColumn(sourceFile, statement.getStart()).line, {
                namedImports, hasDefaultImport, hasNamespaceImport, isSideEffectOnly: !clause
            });
            continue;
        }

        if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
            const expr = statement.moduleReference.expression;
            if (ts.isStringLiteral(expr)) addImport(expr.text, 'importEquals', lineAndColumn(sourceFile, statement.getStart()).line, { hasNamespaceImport: true });
            continue;
        }

        if (ts.isExportDeclaration(statement)) {
            const line = lineAndColumn(sourceFile, statement.getStart()).line;
            if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
                const specifier = statement.moduleSpecifier.text;
                if (!statement.exportClause) {
                    const info = addImport(specifier, 'exportFrom', line, { hasNamespaceImport: true });
                    if (info.resolved) reExportAllTargets.push(info.resolved);
                    continue;
                }
                if (ts.isNamedExports(statement.exportClause)) {
                    for (const element of statement.exportClause.elements) exports.push({ name: element.name.text, kind: 'named', line });
                    addImport(specifier, 'exportFrom', line, {
                        namedImports: statement.exportClause.elements.map((element) => (element.propertyName ?? element.name).text)
                    });
                }
                continue;
            }
            if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
                for (const element of statement.exportClause.elements) exports.push({ name: element.name.text, kind: 'named', line });
            }
            continue;
        }

        if (ts.isExportAssignment(statement)) {
            exports.push({ name: 'default', kind: 'default', line: lineAndColumn(sourceFile, statement.getStart()).line });
            continue;
        }

        const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
        const isExported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
        if (!isExported) continue;
        const isDefault = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
        const line = lineAndColumn(sourceFile, statement.getStart()).line;
        if (isDefault) exports.push({ name: 'default', kind: 'default', line });
        else if (ts.isFunctionDeclaration(statement) && statement.name) exports.push({ name: statement.name.text, kind: 'function', line });
        else if (ts.isClassDeclaration(statement) && statement.name) exports.push({ name: statement.name.text, kind: 'class', line });
        else if (ts.isInterfaceDeclaration(statement)) exports.push({ name: statement.name.text, kind: 'interface', line });
        else if (ts.isTypeAliasDeclaration(statement)) exports.push({ name: statement.name.text, kind: 'typeAlias', line });
        else if (ts.isEnumDeclaration(statement)) exports.push({ name: statement.name.text, kind: 'enum', line });
        else if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) exports.push({ name: declaration.name.text, kind: 'variable', line });
            }
        }
    }

    const dynamicDir = path.relative(projectRoot, path.dirname(file)).replace(/\\/g, '/') || '.';
    forEachNode(sourceFile, (node) => {
        if (!ts.isCallExpression(node)) return;
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        if (!isRequire && !isDynamicImport) return;
        const kind: SpecifierKind = isRequire ? 'require' : 'dynamicImport';
        const argument = node.arguments[0];
        if (!argument || !(ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
            dynamicRequireHints.push(dynamicDir);
            return;
        }

        let namedImports: string[] = [];
        let hasNamespaceImport = true;
        let isSideEffectOnly = false;
        let parent: ts.Node | undefined = node.parent;
        if (ts.isAwaitExpression(parent)) parent = parent.parent;
        if (ts.isVariableDeclaration(parent) && parent.initializer && (parent.initializer === node || (ts.isAwaitExpression(parent.initializer) && parent.initializer.expression === node))) {
            if (ts.isObjectBindingPattern(parent.name)) {
                const hasStaticProperties = parent.name.elements.every((element) => {
                    if (element.dotDotDotToken) return false;
                    const property = element.propertyName ?? element.name;
                    return ts.isIdentifier(property) || ts.isStringLiteral(property) || ts.isNumericLiteral(property);
                });
                if (hasStaticProperties) {
                    namedImports = parent.name.elements.map((element) => (element.propertyName ?? element.name).getText(sourceFile).replace(/^['"]|['"]$/g, ''));
                    hasNamespaceImport = false;
                }
            }
        } else if (isRequire && ts.isExpressionStatement(node.parent)) {
            isSideEffectOnly = true;
        }
        addImport(argument.text, kind, lineAndColumn(sourceFile, node.getStart()).line, { namedImports, hasNamespaceImport, isSideEffectOnly });
    });

    return { imports, exports, reExportAllTargets, dynamicRequireHints };
}

function resolveEntryPoints(projectRoot: string, files: string[], packageJson: Record<string, unknown> | null, config: DevkitConfig): Set<string> {
    const entryPoints = new Set<string>();
    const fileSet = new Set(files);

    const addFromRelativePath = (relativePath: string): void => {
        const resolved = path.resolve(projectRoot, relativePath);
        if (fileSet.has(resolved)) {
            entryPoints.add(resolved);
            return;
        }
        for (const ext of SOURCE_EXTENSIONS) {
            if (fileSet.has(resolved + ext)) {
                entryPoints.add(resolved + ext);
            }
        }
    };

    const scanStringForPaths = (value: string): void => {
        const tokens = value.split(/\s+/);
        for (const token of tokens) {
            const cleaned = token.replace(/^["']|["']$/g, '');
            if ([...SOURCE_EXTENSIONS].some((ext) => cleaned.endsWith(ext))) {
                addFromRelativePath(cleaned);
            }
        }
    };

    if (packageJson) {
        if (typeof packageJson.main === 'string') {
            addFromRelativePath(packageJson.main);
        }

        if (typeof packageJson.bin === 'string') {
            addFromRelativePath(packageJson.bin);
        } else if (packageJson.bin && typeof packageJson.bin === 'object') {
            for (const value of Object.values(packageJson.bin as Record<string, string>)) {
                addFromRelativePath(value);
            }
        }

        const scripts = packageJson.scripts as Record<string, string> | undefined;
        if (scripts) {
            for (const command of Object.values(scripts)) {
                scanStringForPaths(command);
            }
        }

        const addExportTargets = (value: unknown): void => {
            if (typeof value === 'string') {
                if (value.startsWith('./')) addFromRelativePath(value.slice(2));
            } else if (value && typeof value === 'object') {
                for (const nested of Object.values(value as Record<string, unknown>)) addExportTargets(nested);
            }
        };
        addExportTargets(packageJson.exports);

        const dependencies = {
            ...((packageJson.dependencies as Record<string, string> | undefined) ?? {}),
            ...((packageJson.devDependencies as Record<string, string> | undefined) ?? {})
        };
        if (Object.prototype.hasOwnProperty.call(dependencies, 'next')) {
            const patterns = [
                'pages/**/*.js', 'pages/**/*.jsx', 'pages/**/*.ts', 'pages/**/*.tsx',
                'app/**/page.js', 'app/**/page.jsx', 'app/**/page.ts', 'app/**/page.tsx',
                'app/**/layout.js', 'app/**/layout.jsx', 'app/**/layout.ts', 'app/**/layout.tsx',
                'app/**/route.js', 'app/**/route.jsx', 'app/**/route.ts', 'app/**/route.tsx',
                'app/**/loading.js', 'app/**/loading.jsx', 'app/**/loading.ts', 'app/**/loading.tsx',
                'app/**/error.js', 'app/**/error.jsx', 'app/**/error.ts', 'app/**/error.tsx',
                'app/**/not-found.js', 'app/**/not-found.jsx', 'app/**/not-found.ts', 'app/**/not-found.tsx',
                'app/**/middleware.js', 'app/**/middleware.jsx', 'app/**/middleware.ts', 'app/**/middleware.tsx'
            ];
            for (const file of files) {
                const relative = path.relative(projectRoot, file).replace(/\\/g, '/');
                if (matchesAnyGlob(relative, patterns)) entryPoints.add(file);
            }
        }
    }

    // Keep the parameter explicit: framework and custom entry conventions are config-dependent.
    void config;

    for (const file of files) {
        if (isTestFile(file)) {
            entryPoints.add(file);
        }
    }

    return entryPoints;
}

export function buildModuleGraph(
    projectRoot: string,
    files: string[],
    packageJson: Record<string, unknown> | null,
    config: DevkitConfig
): ModuleGraph {
    const fileSet = new Set(files);
    const importsByFile = new Map<string, ImportInfo[]>();
    const exportsByFile = new Map<string, ExportInfo[]>();
    const edges = new Map<string, Set<string>>();
    const reverseEdges = new Map<string, Set<string>>();
    const reExportAllTargets = new Map<string, Set<string>>();
    const dynamicRequireHints = new Set<string>();
    const resolutionContext = createResolutionContext(projectRoot);

    for (const file of files) {
        const text = readFileSafe(file);
        const sourceFile = parseSourceFile(file, text);
        const { imports, exports, reExportAllTargets: reExportTargets, dynamicRequireHints: hints } = extractImportsAndExports(file, projectRoot, sourceFile, fileSet, resolutionContext);
        hints.forEach((hint) => dynamicRequireHints.add(hint));

        importsByFile.set(file, imports);
        exportsByFile.set(file, exports);
        reExportAllTargets.set(file, new Set(reExportTargets));

        const edgeSet = new Set<string>();
        for (const importInfo of imports) {
            if (importInfo.resolved) {
                edgeSet.add(importInfo.resolved);

                if (!reverseEdges.has(importInfo.resolved)) {
                    reverseEdges.set(importInfo.resolved, new Set());
                }
                reverseEdges.get(importInfo.resolved)!.add(file);
            }
        }
        for (const target of reExportTargets) {
            edgeSet.add(target);
            if (!reverseEdges.has(target)) {
                reverseEdges.set(target, new Set());
            }
            reverseEdges.get(target)!.add(file);
        }
        edges.set(file, edgeSet);
    }

    const entryPoints = resolveEntryPoints(projectRoot, files, packageJson, config);

    return { importsByFile, exportsByFile, edges, reverseEdges, reExportAllTargets, entryPoints, fileSet, dynamicRequireHints };
}

export function findImportCycles(graph: ModuleGraph): string[][] {
    const cycles: string[][] = [];
    const visitedGlobal = new Set<string>();

    for (const start of graph.edges.keys()) {
        if (visitedGlobal.has(start)) {
            continue;
        }

        const stack: string[] = [];
        const onStack = new Set<string>();
        const visit = (node: string): void => {
            if (onStack.has(node)) {
                const cycleStart = stack.indexOf(node);
                if (cycleStart !== -1) {
                    cycles.push([...stack.slice(cycleStart), node]);
                }
                return;
            }
            if (visitedGlobal.has(node)) {
                return;
            }

            visitedGlobal.add(node);
            stack.push(node);
            onStack.add(node);

            for (const next of graph.edges.get(node) ?? []) {
                visit(next);
            }

            stack.pop();
            onStack.delete(node);
        };

        visit(start);
    }

    return cycles;
}
