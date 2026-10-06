import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { SOURCE_EXTENSIONS, isTestFile, readFileSafe } from './discovery';
import { parseSourceFile } from './ast/parse';
import { forEachNode, lineAndColumn } from './ast/walk';
import type { DevkitConfig } from './config';
import { isFrameworkEntryFile } from './frameworkConventions';
import { createResolutionContext, loadTsConfigFor, matchesPathAlias, resolveSpecifier, type SpecifierKind } from './moduleResolution';

// Tool config files and task-runner entry files (vite.config.ts, .eslintrc.js, gulpfile.js, karma.conf.js, ...).
const TOOL_CONFIG_FILE = /(?:^|\/)(?:(?:[\w.-]+\.(?:config|conf)|\.[\w-]+rc)\.[cm]?[jt]sx?|(?:gulpfile|gruntfile|jakefile|fastfile)(?:\.[\w-]+)?\.[cm]?[jt]sx?)$/i;

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
    /** `import type` / `export type`: erased at build time, so it creates no runtime dependency or cycle. */
    isTypeOnly: boolean;
    /** Matches a tsconfig `paths` alias (`@/*`), so it names project code rather than an npm package. */
    isPathAlias: boolean;
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
        details: Partial<Pick<ImportInfo, 'namedImports' | 'hasDefaultImport' | 'hasNamespaceImport' | 'isSideEffectOnly' | 'isTypeOnly'>> = {}
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
            kind,
            isTypeOnly: details.isTypeOnly ?? false,
            isPathAlias: !specifier.startsWith('.') && matchesPathAlias(file, specifier, resolutionContext)
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
            let allSpecifiersTypeOnly = false;
            if (clause) {
                hasDefaultImport = !!clause.name;
                if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) hasNamespaceImport = true;
                else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                    for (const element of clause.namedBindings.elements) namedImports.push((element.propertyName ?? element.name).text);
                    // `import { type A, type B }` is as erased as `import type { A, B }`.
                    allSpecifiersTypeOnly = !clause.name && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((element) => element.isTypeOnly);
                }
            }
            addImport(statement.moduleSpecifier.text, 'import', lineAndColumn(sourceFile, statement.getStart()).line, {
                namedImports, hasDefaultImport, hasNamespaceImport, isSideEffectOnly: !clause,
                isTypeOnly: (!!clause && clause.isTypeOnly) || allSpecifiersTypeOnly
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
                    const info = addImport(specifier, 'exportFrom', line, { hasNamespaceImport: true, isTypeOnly: statement.isTypeOnly });
                    if (info.resolved) reExportAllTargets.push(info.resolved);
                    continue;
                }
                if (ts.isNamespaceExport(statement.exportClause)) {
                    // `export * as ns from './x'` exposes the whole module under one name: the target is fully used.
                    exports.push({ name: statement.exportClause.name.text, kind: 'named', line });
                    addImport(specifier, 'exportFrom', line, { hasNamespaceImport: true, isTypeOnly: statement.isTypeOnly });
                    continue;
                }
                if (ts.isNamedExports(statement.exportClause)) {
                    for (const element of statement.exportClause.elements) exports.push({ name: element.name.text, kind: 'named', line });
                    addImport(specifier, 'exportFrom', line, {
                        namedImports: statement.exportClause.elements.map((element) => (element.propertyName ?? element.name).text),
                        isTypeOnly: statement.isTypeOnly
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

// package.json fields that cannot be a source-file reference (or are handled explicitly elsewhere).
const NON_REFERENCE_FIELDS = new Set([
    'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'peerDependenciesMeta', 'bundledDependencies',
    'scripts', 'name', 'version', 'description', 'keywords', 'license', 'author', 'contributors', 'homepage', 'bugs', 'repository',
    'funding', 'files', 'main', 'module', 'browser', 'bin', 'exports', 'types', 'typings', 'engines', 'os', 'cpu', 'packageManager'
]);

// A relative or bare path to a JS/TS file inside free text (JSON, YAML, TOML, Dockerfile, Procfile, shell, CI).
const SOURCE_PATH_REFERENCE = /(?:^|[\s"'`=:(,[])((?:\.{1,2}\/)?[\w@~$.-]+(?:\/[\w@~$.-]+)*\.[cm]?[jt]sx?)(?=$|[\s"'`,;:)\]])/g;
// A quoted relative path inside a tool's own config (`preset: '../jest.preset.js'`, `setupFiles: ['./setup']`).
const QUOTED_RELATIVE_REFERENCE = /["'`](\.{1,2}\/[^"'`\n]+)["'`]/g;
const DOCUMENTATION_TEXT = /\.(?:md|mdx|markdown|rst|txt|adoc)$/i;

/**
 * Source files that other tooling points at by path, so no import ever mentions them: the `main` of an Nx
 * project.json, a Dockerfile `CMD`, a CI step, a jest preset. A path in configuration is a use.
 */
function resolveConfigReferences(projectRoot: string, files: string[], textFiles: string[], entryPoints: Set<string>): void {
    const fileSet = new Set(files);
    const addReference = (bases: string[], reference: string): void => {
        for (const base of bases) {
            const absolute = path.resolve(base, reference);
            if (fileSet.has(absolute)) { entryPoints.add(absolute); return; }
            for (const extension of SOURCE_EXTENSIONS) {
                if (fileSet.has(absolute + extension)) { entryPoints.add(absolute + extension); return; }
                if (fileSet.has(path.join(absolute, `index${extension}`))) { entryPoints.add(path.join(absolute, `index${extension}`)); return; }
            }
        }
    };

    for (const file of textFiles) {
        if (DOCUMENTATION_TEXT.test(file)) continue;
        const text = readFileSafe(file);
        if (!text || text.length > 500_000) continue;
        const bases = [path.dirname(file), projectRoot];
        for (const match of text.matchAll(SOURCE_PATH_REFERENCE)) addReference(bases, match[1]);
    }

    for (const file of files) {
        if (!TOOL_CONFIG_FILE.test(path.relative(projectRoot, file).replace(/\\/g, '/'))) continue;
        const text = readFileSafe(file);
        for (const match of text.matchAll(QUOTED_RELATIVE_REFERENCE)) addReference([path.dirname(file)], match[1]);
    }
}

/** Output folders a library's `exports`/`main` typically point into, mapped back to the sources they were built from. */
const BUILD_OUTPUT_EXTENSIONS = /(?:\.d\.[cm]?ts|\.[cm]?jsx?)$/;

function sourceCandidatesForBuildOutput(packageRoot: string, relativePath: string, fileSet: Set<string>): string[] {
    const normalized = relativePath.replace(/^\.\//, '').replace(/\\/g, '/');
    if (!BUILD_OUTPUT_EXTENSIONS.test(normalized)) return [];
    const withoutExtension = normalized.replace(BUILD_OUTPUT_EXTENSIONS, '');

    const config = loadTsConfigFor(packageRoot);
    const outDir = config?.options.outDir ? path.relative(packageRoot, config.options.outDir).replace(/\\/g, '/') : null;
    const rootDir = config?.options.rootDir ? path.relative(packageRoot, config.options.rootDir).replace(/\\/g, '/') : null;

    const bases = new Set<string>();
    // The project's own mapping first: <outDir>/x.js was built from <rootDir>/x.ts.
    if (outDir && withoutExtension.startsWith(`${outDir}/`)) bases.add(`${rootDir && rootDir !== '.' ? `${rootDir}/` : ''}${withoutExtension.slice(outDir.length + 1)}`);
    // Otherwise assume the conventional layout: the first folder is the output, sources live in src/ or the package root.
    const [, ...rest] = withoutExtension.split('/');
    if (rest.length > 0) {
        bases.add(`src/${rest.join('/')}`);
        bases.add(rest.join('/'));
    }
    bases.add(`src/${withoutExtension}`);
    bases.add(withoutExtension);

    const found: string[] = [];
    for (const base of bases) {
        const absolute = path.resolve(packageRoot, base);
        for (const extension of SOURCE_EXTENSIONS) {
            if (fileSet.has(absolute + extension)) found.push(absolute + extension);
            if (fileSet.has(path.join(absolute, `index${extension}`))) found.push(path.join(absolute, `index${extension}`));
        }
    }
    return found;
}

function resolvePackageEntryPoints(
    packageRoot: string,
    files: string[],
    packageJson: Record<string, unknown> | null,
    entryPoints: Set<string>
): void {
    const fileSet = new Set(files);

    const addFromRelativePath = (relativePath: string): void => {
        const resolved = path.resolve(packageRoot, relativePath);
        if (fileSet.has(resolved)) {
            entryPoints.add(resolved);
            return;
        }
        let found = false;
        for (const ext of SOURCE_EXTENSIONS) {
            if (fileSet.has(resolved + ext)) {
                entryPoints.add(resolved + ext);
                found = true;
            }
        }
        // `main: dist/index.js` while only src/index.ts is checked in.
        if (!found) for (const source of sourceCandidatesForBuildOutput(packageRoot, relativePath, fileSet)) entryPoints.add(source);
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

        // Alternate entry fields consumed by bundlers/CDNs. `browser` may also be a map of file replacements
        // (`"./lib/node.js": "./lib/browser.js"`): both sides are loaded depending on the target platform.
        for (const field of ['module', 'jsnext:main', 'unpkg', 'jsdelivr', 'react-native', 'es2015', 'esnext']) {
            if (typeof packageJson[field] === 'string') addFromRelativePath(packageJson[field] as string);
        }
        const browserField = packageJson.browser;
        if (typeof browserField === 'string') addFromRelativePath(browserField);
        else if (browserField && typeof browserField === 'object') {
            for (const [from, to] of Object.entries(browserField as Record<string, unknown>)) {
                if (from.startsWith('.')) addFromRelativePath(from);
                if (typeof to === 'string' && to.startsWith('.')) addFromRelativePath(to);
            }
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

        // Tool configuration embedded in package.json names source files too (`"prisma": { "seed": "ts-node src/seed.ts" }`).
        const collectStrings = (value: unknown, into: string[]): void => {
            if (typeof value === 'string') into.push(value);
            else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, into));
            else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach((item) => collectStrings(item, into));
        };
        for (const [field, value] of Object.entries(packageJson)) {
            if (NON_REFERENCE_FIELDS.has(field)) continue;
            const strings: string[] = [];
            collectStrings(value, strings);
            strings.forEach(scanStringForPaths);
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
        const declared = new Set(Object.keys(dependencies));
        for (const file of files) {
            const relative = path.relative(packageRoot, file).replace(/\\/g, '/');
            if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
            if (isFrameworkEntryFile(relative, declared)) entryPoints.add(file);
        }
    }
}

/** Directories (project root and every nested package) that contain a package.json, found by walking up from each source file. */
function findPackageRoots(projectRoot: string, files: string[]): string[] {
    const roots = new Set<string>([projectRoot]);
    const checked = new Map<string, boolean>();
    for (const file of files) {
        for (let dir = path.dirname(file); dir.startsWith(projectRoot) && dir !== projectRoot; dir = path.dirname(dir)) {
            if (checked.has(dir)) {
                if (checked.get(dir)) break;
                continue;
            }
            const has = fs.existsSync(path.join(dir, 'package.json'));
            checked.set(dir, has);
            if (has) {
                roots.add(dir);
                break;
            }
        }
    }
    return [...roots];
}

function resolveEntryPoints(projectRoot: string, files: string[], packageJson: Record<string, unknown> | null, config: DevkitConfig, textFiles: string[]): Set<string> {
    const entryPoints = new Set<string>();

    // In a monorepo every package has its own main/exports/bin and its own framework: next in packages/docs
    // makes app/page.tsx there an entry point even though the root package.json never mentions next.
    for (const packageRoot of findPackageRoots(projectRoot, files)) {
        if (packageRoot === projectRoot) {
            resolvePackageEntryPoints(projectRoot, files, packageJson, entryPoints);
            continue;
        }
        try {
            resolvePackageEntryPoints(packageRoot, files, JSON.parse(readFileSafe(path.join(packageRoot, 'package.json'))), entryPoints);
        } catch {
            // An unreadable nested manifest contributes no entry points.
        }
    }

    resolveConfigReferences(projectRoot, files, textFiles, entryPoints);

    // Keep the parameter explicit: framework and custom entry conventions are config-dependent.
    void config;

    for (const file of files) {
        const relative = path.relative(projectRoot, file).replace(/\\/g, '/');
        // Tests and tool config files (vite.config.ts, eslint.config.mjs, ...) are loaded by tools, not imported.
        if (isTestFile(relative) || TOOL_CONFIG_FILE.test(relative)) {
            entryPoints.add(file);
        }
    }

    return entryPoints;
}

export function buildModuleGraph(
    projectRoot: string,
    files: string[],
    packageJson: Record<string, unknown> | null,
    config: DevkitConfig,
    textFiles: string[] = []
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

    const entryPoints = resolveEntryPoints(projectRoot, files, packageJson, config, textFiles);

    return { importsByFile, exportsByFile, edges, reverseEdges, reExportAllTargets, entryPoints, fileSet, dynamicRequireHints };
}

/**
 * One representative cycle per strongly connected component of the *runtime* import graph.
 *
 * Type-only imports are erased by the compiler, so they cannot cause an initialization-order problem and
 * are ignored. Enumerating every simple path through a tangled component would report one real problem
 * dozens of times, so each component is reported once, as the shortest cycle through its first file.
 */
export function findImportCycles(graph: ModuleGraph): string[][] {
    const runtimeEdges = new Map<string, string[]>();
    for (const [file, imports] of graph.importsByFile) {
        const targets = new Set<string>();
        for (const info of imports) if (info.resolved && !info.isTypeOnly) targets.add(info.resolved);
        for (const target of graph.reExportAllTargets.get(file) ?? []) targets.add(target);
        runtimeEdges.set(file, [...targets]);
    }

    // Tarjan's algorithm (iterative, to survive deep import chains).
    let counter = 0;
    const index = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const components: string[][] = [];

    for (const root of runtimeEdges.keys()) {
        if (index.has(root)) continue;
        const work: Array<{ node: string; next: number }> = [{ node: root, next: 0 }];
        index.set(root, counter); lowlink.set(root, counter); counter += 1;
        stack.push(root); onStack.add(root);

        while (work.length > 0) {
            const frame = work[work.length - 1];
            const targets = runtimeEdges.get(frame.node) ?? [];
            if (frame.next < targets.length) {
                const target = targets[frame.next++];
                if (!runtimeEdges.has(target)) continue;
                if (!index.has(target)) {
                    index.set(target, counter); lowlink.set(target, counter); counter += 1;
                    stack.push(target); onStack.add(target);
                    work.push({ node: target, next: 0 });
                } else if (onStack.has(target)) {
                    lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, index.get(target)!));
                }
                continue;
            }

            work.pop();
            if (work.length > 0) {
                const parent = work[work.length - 1].node;
                lowlink.set(parent, Math.min(lowlink.get(parent)!, lowlink.get(frame.node)!));
            }
            if (lowlink.get(frame.node) === index.get(frame.node)) {
                const component: string[] = [];
                let member: string;
                do {
                    member = stack.pop()!;
                    onStack.delete(member);
                    component.push(member);
                } while (member !== frame.node);
                const selfLoop = component.length === 1 && (runtimeEdges.get(component[0]) ?? []).includes(component[0]);
                if (component.length > 1 || selfLoop) components.push(component);
            }
        }
    }

    return components.map((component) => shortestCycleThrough(component.sort()[0], new Set(component), runtimeEdges));
}

function shortestCycleThrough(start: string, members: Set<string>, edges: Map<string, string[]>): string[] {
    const previous = new Map<string, string>();
    const queue = [start];
    for (let head = 0; head < queue.length; head += 1) {
        const node = queue[head];
        for (const next of edges.get(node) ?? []) {
            if (!members.has(next)) continue;
            if (next === start) {
                const cycle = [start];
                for (let current = node; current !== start; current = previous.get(current)!) cycle.splice(1, 0, current);
                return [...cycle, start];
            }
            if (!previous.has(next)) {
                previous.set(next, node);
                queue.push(next);
            }
        }
    }
    return [start, start];
}
