import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { SOURCE_EXTENSIONS, isTestFile, readFileSafe } from './discovery';
import { parseSourceFile } from './ast/parse';
import { forEachNode, lineAndColumn } from './ast/walk';
import type { DevkitConfig } from './config';
import { isFrameworkEntryFile } from './frameworkConventions';
import { createResolutionContext, matchesPathAlias, resolveSpecifier, type SpecifierKind } from './moduleResolution';
import { createWorkspaceResolver, findPackageRoots, sourceCandidatesForBuildOutput } from './workspaceResolution';
import { FILE_FUNCTION_NAMES } from './rules/securityHelpers';
import { mdxImportSpecifiers } from './mdxImports';

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
    /** Directories whose files are read by a path assembled at runtime (see collectFilesystemPrefixes). */
    dynamicPathDirectories: Set<string>;
    /** Files made only of `export ... from` statements: they re-export other modules and define nothing themselves. */
    barrelFiles: Set<string>;
    /** Package roots (longest first) with whether each is published: not private, and declares `exports` or `files`. */
    packages: Array<{ root: string; published: boolean }>;
}

const FILE_READ_FUNCTIONS = new Set([...FILE_FUNCTION_NAMES, 'readdir', 'readdirSync', 'existsSync', 'exists', 'lstat', 'lstatSync', 'copyFile', 'copyFileSync', 'sendFile', 'createReadStream']);
const DIRECTORY_PREFIX = /^(?:\.{1,2}\/)?[\w@~.-]+(?:\/[\w@~.-]+)*\/$/;

/**
 * Directories that code names as the start of a path built at runtime inside a filesystem call:
 * `fs.readFile('./data/snippets/' + key + '.ts')`. Every file in such a directory is read by name, so none of
 * them is unused even though no import mentions it.
 */
function collectFilesystemPrefixes(sourceFile: ts.SourceFile, file: string, projectRoot: string, into: string[]): void {
    const prefixOf = (expression: ts.Node): string | undefined => {
        if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) return prefixOf(expression.left);
        if (ts.isStringLiteral(expression)) return expression.text;
        if (ts.isTemplateExpression(expression)) return expression.head.text;
        return undefined;
    };
    forEachNode(sourceFile, (node) => {
        if (!ts.isCallExpression(node)) return;
        const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : undefined;
        const argument = node.arguments[0];
        if (!name || !FILE_READ_FUNCTIONS.has(name) || !argument) return;
        const dynamic = (ts.isBinaryExpression(argument) && argument.operatorToken.kind === ts.SyntaxKind.PlusToken) || ts.isTemplateExpression(argument);
        const prefix = dynamic ? prefixOf(argument) : undefined;
        if (!prefix) return;
        // `'data/' + x` ends in a separator; `'./data/x-' + y` names a file prefix, not a directory.
        const directory = prefix.endsWith('/') ? prefix : prefix.slice(0, prefix.lastIndexOf('/') + 1);
        if (!DIRECTORY_PREFIX.test(directory)) return;
        for (const base of [path.dirname(file), projectRoot]) {
            const resolved = path.resolve(base, directory);
            if (resolved !== projectRoot && fs.existsSync(resolved)) into.push(resolved);
        }
    });
}

function extractImportsAndExports(
    file: string,
    projectRoot: string,
    sourceFile: ts.SourceFile,
    fileSet: Set<string>,
    resolutionContext: ReturnType<typeof createResolutionContext>,
    resolveWorkspace: (specifier: string, fromFile?: string) => string | null
): { imports: ImportInfo[]; exports: ExportInfo[]; reExportAllTargets: string[]; dynamicRequireHints: string[]; isBarrel: boolean; pathPrefixes: string[] } {
    const imports: ImportInfo[] = [];
    const exports: ExportInfo[] = [];
    const reExportAllTargets: string[] = [];
    const dynamicRequireHints: string[] = [];
    const pathPrefixes: string[] = [];

    const addImport = (
        specifier: string,
        kind: SpecifierKind,
        line: number,
        details: Partial<Pick<ImportInfo, 'namedImports' | 'hasDefaultImport' | 'hasNamespaceImport' | 'isSideEffectOnly' | 'isTypeOnly'>> = {}
    ): ImportInfo => {
        const info: ImportInfo = {
            specifier,
            resolved: resolveSpecifier(file, specifier, kind, fileSet, resolutionContext) ?? resolveWorkspace(specifier, file),
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
        // `require.resolve('pkg/file.js')` names a file as surely as `require('pkg/file.js')`.
        const isRequireResolve = ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'resolve' &&
            ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'require';
        const isRequire = isRequireResolve || (ts.isIdentifier(node.expression) && node.expression.text === 'require');
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

    // A barrel only forwards other modules: every statement is `export ... from '...'`.
    const isBarrel = sourceFile.statements.length > 0 &&
        sourceFile.statements.every((statement) => ts.isExportDeclaration(statement) && !!statement.moduleSpecifier);

    collectFilesystemPrefixes(sourceFile, file, projectRoot, pathPrefixes);

    return { imports, exports, reExportAllTargets, dynamicRequireHints, isBarrel, pathPrefixes };
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
const MDX_FILE = /\.mdx?$/i;
/** The directory of the closest package.json above `file`, which is what `@site` stands for in Docusaurus. */
function nearestPackageDir(projectRoot: string, file: string): string {
    for (let dir = path.dirname(file); dir.startsWith(projectRoot); dir = path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
        if (dir === projectRoot) break;
    }
    return projectRoot;
}

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
        if (MDX_FILE.test(file)) {
            // Docusaurus and other MDX pipelines compile `.md` files as MDX too, so their imports are real uses.
            for (const specifier of mdxImportSpecifiers(readFileSafe(file))) {
                if (specifier.startsWith('@site/')) addReference([nearestPackageDir(projectRoot, file)], specifier.slice('@site/'.length));
                else if (specifier.startsWith('.')) addReference([path.dirname(file)], specifier);
            }
            continue;
        }
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

    // `"./*": "./dist/*.js"` publishes every file under the pattern. Build output is not checked in, so each
    // source file is compared by the output paths it would produce (src/a/b.ts -> dist/a/b.js).
    const addWildcardTarget = (pattern: string): void => {
        if (!pattern.startsWith('./')) return;
        const escaped = pattern.slice(2).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        const matcher = new RegExp(`^${escaped}$`);
        const outputFolder = pattern.slice(2).split('/')[0];
        for (const file of files) {
            const relative = path.relative(packageRoot, file).replace(/\\/g, '/');
            if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
            const stem = relative.replace(/\.[cm]?[jt]sx?$/, '');
            const unrooted = stem.replace(/^src\//, '');
            const guesses = [relative, ...['', '.d'].flatMap((marker) => ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'].flatMap((extension) =>
                [`${outputFolder}/${unrooted}${marker}${extension}`, `${stem}${marker}${extension}`]))];
            if (guesses.some((guess) => matcher.test(guess))) entryPoints.add(file);
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
                if (value.includes('*')) addWildcardTarget(value);
                else if (value.startsWith('./')) addFromRelativePath(value.slice(2));
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
        // A package that names no entry point of its own is still entered through src/index or main.
        const namesEntryPoint = ['main', 'module', 'exports', 'bin', 'browser'].some((field) => packageJson[field] !== undefined);
        for (const file of files) {
            const relative = path.relative(packageRoot, file).replace(/\\/g, '/');
            if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
            if (isFrameworkEntryFile(relative, declared)) entryPoints.add(file);
            if (!namesEntryPoint && /^(?:src\/)?(?:index|main)\.[cm]?[jt]sx?$/.test(relative)) entryPoints.add(file);
        }
    }
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

function describePackages(projectRoot: string, files: string[], rootJson: Record<string, unknown> | null): ModuleGraph['packages'] {
    const published = (json: Record<string, unknown> | null): boolean => !!json && json.private !== true && (json.exports !== undefined || Array.isArray(json.files));
    const packages = findPackageRoots(projectRoot, files).map((root) => {
        if (root === projectRoot) return { root, published: published(rootJson) };
        try {
            return { root, published: published(JSON.parse(readFileSafe(path.join(root, 'package.json'))) as Record<string, unknown>) };
        } catch {
            return { root, published: false };
        }
    });
    return packages.sort((a, b) => b.root.length - a.root.length);
}

/** Whether the file belongs to a published package, whose exports may be consumed outside this repository. */
export function isInPublishedPackage(graph: ModuleGraph, file: string): boolean {
    const owner = graph.packages.find(({ root }) => file === root || file.startsWith(root + path.sep));
    return owner?.published ?? false;
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
    const dynamicPathDirectories = new Set<string>();
    const resolutionContext = createResolutionContext(projectRoot);
    const resolveWorkspace = createWorkspaceResolver(projectRoot, files, fileSet);
    const barrelFiles = new Set<string>();

    for (const file of files) {
        const text = readFileSafe(file);
        const sourceFile = parseSourceFile(file, text);
        const { imports, exports, reExportAllTargets: reExportTargets, dynamicRequireHints: hints, isBarrel, pathPrefixes } = extractImportsAndExports(file, projectRoot, sourceFile, fileSet, resolutionContext, resolveWorkspace);
        if (isBarrel) barrelFiles.add(file);
        hints.forEach((hint) => dynamicRequireHints.add(hint));
        pathPrefixes.forEach((prefix) => dynamicPathDirectories.add(prefix));

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
    for (const file of files) {
        for (const directory of dynamicPathDirectories) if (file.startsWith(directory + path.sep)) { entryPoints.add(file); break; }
    }

    return { importsByFile, exportsByFile, edges, reverseEdges, reExportAllTargets, entryPoints, fileSet, dynamicRequireHints, dynamicPathDirectories, barrelFiles, packages: describePackages(projectRoot, files, packageJson) };
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
