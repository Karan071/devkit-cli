import path from 'node:path';
import ts from 'typescript';
import { SOURCE_EXTENSIONS } from './discovery';

export interface ResolutionContext {
    compilerOptions: ts.CompilerOptions;
    cache: ts.ModuleResolutionCache;
    host: ts.ModuleResolutionHost;
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

export function loadScannedTsConfig(projectRoot: string): ts.CompilerOptions {
    const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) return { ...FALLBACK_RESOLUTION_OPTIONS };

    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) return { ...FALLBACK_RESOLUTION_OPTIONS };

    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath), FALLBACK_RESOLUTION_OPTIONS, configPath);
    return { ...FALLBACK_RESOLUTION_OPTIONS, ...parsed.options };
}

export function createResolutionContext(projectRoot: string): ResolutionContext {
    const compilerOptions = loadScannedTsConfig(projectRoot);
    const cache = ts.createModuleResolutionCache(
        projectRoot,
        ts.sys.useCaseSensitiveFileNames ? (fileName) => fileName : (fileName) => fileName.toLowerCase(),
        compilerOptions
    );
    return { compilerOptions, cache, host: ts.sys };
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
    const result = ts.resolveModuleName(
        specifier,
        fromFile,
        context.compilerOptions,
        context.host,
        context.cache,
        undefined,
        mode
    ).resolvedModule;

    if (!result) return null;
    const resolved = path.resolve(result.resolvedFileName);
    return normalizedFiles.has(resolved) ? resolved : null;
}
