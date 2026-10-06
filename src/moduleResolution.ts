import path from 'node:path';
import ts from 'typescript';
import { SOURCE_EXTENSIONS } from './discovery';

export interface ResolutionContext {
    compilerOptions: ts.CompilerOptions;
    cache: ts.ModuleResolutionCache;
    host: ts.ModuleResolutionHost;
    /** Resolution settings for the tsconfig that governs a given directory (monorepo packages differ). */
    scopeFor?: (directory: string) => { compilerOptions: ts.CompilerOptions; cache: ts.ModuleResolutionCache; pathPatterns: string[] };
}

export type SpecifierKind = 'import' | 'importEquals' | 'require' | 'dynamicImport' | 'exportFrom';

const FALLBACK_RESOLUTION_OPTIONS: ts.CompilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    module: ts.ModuleKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    allowJs: true,
    resolveJsonModule: true,
    esModuleInterop: true
};

interface LoadedTsConfig {
    options: ts.CompilerOptions;
    /** Raw `paths` keys, e.g. `@/*`, used to tell a path alias from an npm package. */
    pathPatterns: string[];
}

function parseTsConfigFile(configPath: string, seen = new Set<string>()): LoadedTsConfig | null {
    if (seen.has(configPath)) return null;
    seen.add(configPath);
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) return null;

    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath), FALLBACK_RESOLUTION_OPTIONS, configPath);
    let options: ts.CompilerOptions = { ...parsed.options };

    // Solution-style configs (`"references": [...]`, `files: []`) carry their real options in the referenced projects.
    for (const reference of parsed.projectReferences ?? []) {
        const referencedPath = ts.sys.directoryExists(reference.path) ? path.join(reference.path, 'tsconfig.json') : reference.path;
        const referenced = parseTsConfigFile(referencedPath, seen);
        if (referenced) options = { ...referenced.options, ...options, paths: options.paths ?? referenced.options.paths, baseUrl: options.baseUrl ?? referenced.options.baseUrl };
    }

    return { options, pathPatterns: Object.keys(options.paths ?? {}) };
}

/** Compiler options of the `tsconfig.json` that governs `startDir` (nearest ancestor), or null when none applies. */
export function loadTsConfigFor(startDir: string): (LoadedTsConfig & { configPath: string }) | null {
    const configPath = ts.findConfigFile(startDir, ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) return null;
    const loaded = parseTsConfigFile(configPath);
    return loaded ? { ...loaded, configPath } : null;
}

export function loadScannedTsConfig(projectRoot: string): ts.CompilerOptions {
    const loaded = loadTsConfigFor(projectRoot);
    return loaded ? { ...FALLBACK_RESOLUTION_OPTIONS, ...loaded.options } : { ...FALLBACK_RESOLUTION_OPTIONS };
}

interface ScopedResolution {
    compilerOptions: ts.CompilerOptions;
    cache: ts.ModuleResolutionCache;
    pathPatterns: string[];
}

export function createResolutionContext(projectRoot: string): ResolutionContext {
    const scopes = new Map<string, ScopedResolution>();
    const dirScope = new Map<string, ScopedResolution>();

    const scopeFor = (directory: string): ScopedResolution => {
        const known = dirScope.get(directory);
        if (known) return known;

        // In a monorepo every package may have its own tsconfig (and its own `paths` aliases).
        const config = loadTsConfigFor(directory);
        const key = config?.configPath ?? '';
        let scope = scopes.get(key);
        if (!scope) {
            const compilerOptions = { ...FALLBACK_RESOLUTION_OPTIONS, ...(config?.options ?? {}) };
            scope = {
                compilerOptions,
                pathPatterns: config?.pathPatterns ?? [],
                cache: ts.createModuleResolutionCache(
                    projectRoot,
                    ts.sys.useCaseSensitiveFileNames ? (fileName) => fileName : (fileName) => fileName.toLowerCase(),
                    compilerOptions
                )
            };
            scopes.set(key, scope);
        }
        dirScope.set(directory, scope);
        return scope;
    };

    const rootScope = scopeFor(projectRoot);
    return { compilerOptions: rootScope.compilerOptions, cache: rootScope.cache, host: ts.sys, scopeFor };
}

/** Whether `specifier` matches a tsconfig `paths` pattern (`@/*`, `~/lib/*`, exact names), i.e. is not an npm package. */
export function matchesPathAlias(fromFile: string, specifier: string, context: ResolutionContext): boolean {
    const scope = context.scopeFor?.(path.dirname(fromFile));
    return !!scope?.pathPatterns.some((pattern) => {
        if (!pattern.includes('*')) return pattern === specifier;
        const [prefix, suffix] = pattern.split('*');
        return specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix);
    });
}

function resolveRelativeCheap(fromFile: string, specifier: string, fileSet: Set<string>): string | null {
    const base = path.resolve(path.dirname(fromFile), specifier);
    const direct = [base, ...[...SOURCE_EXTENSIONS].map((extension) => base + extension)];
    for (const candidate of direct) if (fileSet.has(candidate)) return candidate;
    for (const extension of SOURCE_EXTENSIONS) {
        const candidate = path.join(base, `index${extension}`);
        if (fileSet.has(candidate)) return candidate;
    }
    return null;
}

export function resolveSpecifier(
    fromFile: string,
    specifier: string,
    kind: SpecifierKind,
    fileSet: Set<string>,
    context: ResolutionContext
): string | null {
    const normalizedFiles = fileSet;
    if (specifier.startsWith('.')) {
        const cheap = resolveRelativeCheap(fromFile, specifier, normalizedFiles);
        if (cheap) return cheap;
    }

    // TypeScript treats ESNext as an explicit package-condition mode and can skip `paths`
    // mappings under NodeNext. The default is correct for ESM imports and path aliases;
    // only CommonJS specifiers need an explicit condition mode.
    const mode = kind === 'require' || kind === 'importEquals' ? ts.ModuleKind.CommonJS : undefined;
    const scope = context.scopeFor?.(path.dirname(fromFile));
    const result = ts.resolveModuleName(
        specifier,
        fromFile,
        scope?.compilerOptions ?? context.compilerOptions,
        context.host,
        scope?.cache ?? context.cache,
        undefined,
        mode
    ).resolvedModule;

    if (!result) return null;
    const resolved = path.resolve(result.resolvedFileName);
    return normalizedFiles.has(resolved) ? resolved : null;
}
