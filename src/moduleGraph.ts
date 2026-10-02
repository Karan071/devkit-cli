import path from 'node:path';
import ts from 'typescript';
import { SOURCE_EXTENSIONS, isTestFile, readFileSafe } from './discovery';
import { parseSourceFile } from './ast/parse';
import { lineAndColumn } from './ast/walk';

export interface ImportInfo {
    specifier: string;
    resolved: string | null;
    isRelative: boolean;
    namedImports: string[];
    hasDefaultImport: boolean;
    hasNamespaceImport: boolean;
    isSideEffectOnly: boolean;
    line: number;
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
}

function resolveRelativeImport(fromFile: string, specifier: string, fileSet: Set<string>): string | null {
    const baseDir = path.dirname(fromFile);
    const candidateBase = path.resolve(baseDir, specifier);

    const directCandidates = [candidateBase, ...[...SOURCE_EXTENSIONS].map((ext) => candidateBase + ext)];
    for (const candidate of directCandidates) {
        if (fileSet.has(candidate)) {
            return candidate;
        }
    }

    const indexCandidates = [...SOURCE_EXTENSIONS].map((ext) => path.join(candidateBase, `index${ext}`));
    for (const candidate of indexCandidates) {
        if (fileSet.has(candidate)) {
            return candidate;
        }
    }

    return null;
}

function extractImportsAndExports(
    file: string,
    sourceFile: ts.SourceFile,
    fileSet: Set<string>
): { imports: ImportInfo[]; exports: ExportInfo[]; reExportAllTargets: string[] } {
    const imports: ImportInfo[] = [];
    const exports: ExportInfo[] = [];
    const reExportAllTargets: string[] = [];

    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
            const specifier = statement.moduleSpecifier.text;
            const isRelative = specifier.startsWith('.');
            const resolved = isRelative ? resolveRelativeImport(file, specifier, fileSet) : null;
            const line = lineAndColumn(sourceFile, statement.getStart()).line;

            const namedImports: string[] = [];
            let hasDefaultImport = false;
            let hasNamespaceImport = false;

            const clause = statement.importClause;
            if (clause) {
                if (clause.name) {
                    hasDefaultImport = true;
                }
                if (clause.namedBindings) {
                    if (ts.isNamespaceImport(clause.namedBindings)) {
                        hasNamespaceImport = true;
                    } else if (ts.isNamedImports(clause.namedBindings)) {
                        for (const element of clause.namedBindings.elements) {
                            namedImports.push((element.propertyName ?? element.name).text);
                        }
                    }
                }
            }

            imports.push({
                specifier,
                resolved,
                isRelative,
                namedImports,
                hasDefaultImport,
                hasNamespaceImport,
                isSideEffectOnly: !clause,
                line
            });
            continue;
        }

        if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
            const expr = statement.moduleReference.expression;
            if (ts.isStringLiteral(expr)) {
                const specifier = expr.text;
                const isRelative = specifier.startsWith('.');
                imports.push({
                    specifier,
                    resolved: isRelative ? resolveRelativeImport(file, specifier, fileSet) : null,
                    isRelative,
                    namedImports: [],
                    hasDefaultImport: false,
                    hasNamespaceImport: true,
                    isSideEffectOnly: false,
                    line: lineAndColumn(sourceFile, statement.getStart()).line
                });
            }
            continue;
        }

        if (ts.isExportDeclaration(statement)) {
            const line = lineAndColumn(sourceFile, statement.getStart()).line;

            if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
                const specifier = statement.moduleSpecifier.text;
                const isRelative = specifier.startsWith('.');
                const resolved = isRelative ? resolveRelativeImport(file, specifier, fileSet) : null;

                if (!statement.exportClause) {
                    if (resolved) {
                        reExportAllTargets.push(resolved);
                    }
                    continue;
                }

                if (ts.isNamedExports(statement.exportClause)) {
                    for (const element of statement.exportClause.elements) {
                        exports.push({ name: element.name.text, kind: 'named', line });
                    }
                    if (resolved) {
                        imports.push({
                            specifier,
                            resolved,
                            isRelative,
                            namedImports: statement.exportClause.elements.map((element) => (element.propertyName ?? element.name).text),
                            hasDefaultImport: false,
                            hasNamespaceImport: false,
                            isSideEffectOnly: false,
                            line
                        });
                    }
                }
                continue;
            }

            if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
                for (const element of statement.exportClause.elements) {
                    exports.push({ name: element.name.text, kind: 'named', line });
                }
            }
            continue;
        }

        if (ts.isExportAssignment(statement)) {
            exports.push({ name: 'default', kind: 'default', line: lineAndColumn(sourceFile, statement.getStart()).line });
            continue;
        }

        const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
        const isExported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
        if (!isExported) {
            continue;
        }

        const isDefault = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
        const line = lineAndColumn(sourceFile, statement.getStart()).line;

        if (isDefault) {
            exports.push({ name: 'default', kind: 'default', line });
            continue;
        }

        if (ts.isFunctionDeclaration(statement) && statement.name) {
            exports.push({ name: statement.name.text, kind: 'function', line });
        } else if (ts.isClassDeclaration(statement) && statement.name) {
            exports.push({ name: statement.name.text, kind: 'class', line });
        } else if (ts.isInterfaceDeclaration(statement)) {
            exports.push({ name: statement.name.text, kind: 'interface', line });
        } else if (ts.isTypeAliasDeclaration(statement)) {
            exports.push({ name: statement.name.text, kind: 'typeAlias', line });
        } else if (ts.isEnumDeclaration(statement)) {
            exports.push({ name: statement.name.text, kind: 'enum', line });
        } else if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) {
                    exports.push({ name: declaration.name.text, kind: 'variable', line });
                }
            }
        }
    }

    return { imports, exports, reExportAllTargets };
}

function resolveEntryPoints(projectRoot: string, files: string[], packageJson: Record<string, unknown> | null): Set<string> {
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
    }

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
    packageJson: Record<string, unknown> | null
): ModuleGraph {
    const fileSet = new Set(files);
    const importsByFile = new Map<string, ImportInfo[]>();
    const exportsByFile = new Map<string, ExportInfo[]>();
    const edges = new Map<string, Set<string>>();
    const reverseEdges = new Map<string, Set<string>>();
    const reExportAllTargets = new Map<string, Set<string>>();

    for (const file of files) {
        const text = readFileSafe(file);
        const sourceFile = parseSourceFile(file, text);
        const { imports, exports, reExportAllTargets: reExportTargets } = extractImportsAndExports(file, sourceFile, fileSet);

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

    const entryPoints = resolveEntryPoints(projectRoot, files, packageJson);

    return { importsByFile, exportsByFile, edges, reverseEdges, reExportAllTargets, entryPoints, fileSet };
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
