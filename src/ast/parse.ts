import path from 'node:path';
import ts from 'typescript';

function scriptKindFor(filePath: string): ts.ScriptKind {
    const ext = path.extname(filePath).toLowerCase();

    switch (ext) {
        case '.tsx':
            return ts.ScriptKind.TSX;
        case '.jsx':
            return ts.ScriptKind.JSX;
        case '.ts':
            return ts.ScriptKind.TS;
        case '.mjs':
        case '.cjs':
        case '.js':
            return ts.ScriptKind.JS;
        default:
            return ts.ScriptKind.Unknown;
    }
}

export function parseSourceFile(filePath: string, text: string): ts.SourceFile {
    return ts.createSourceFile(filePath, text, ts.ScriptTarget.ES2022, true, scriptKindFor(filePath));
}

export const PROGRAM_COMPILER_OPTIONS: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    // Internal switches: the compiler only produces the unused-symbol and implicit-any diagnostics the
    // rules read when these are on. Whether a *finding* is reported is decided against the project's own
    // settings (see ProjectTypeSettings), not against these.
    checkJs: true,
    noEmit: true,
    skipLibCheck: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    noImplicitAny: true,
    strictNullChecks: true,
    strict: false
};

/** What the scanned project itself asked the compiler to enforce. Rules must not be stricter than this. */
export interface ProjectTypeSettings {
    /** A tsconfig.json governs the project root. */
    hasTsConfig: boolean;
    noImplicitAny: boolean;
    checkJs: boolean;
    noUnusedParameters: boolean;
}

export function readProjectTypeSettings(options: ts.CompilerOptions, hasTsConfig: boolean): ProjectTypeSettings {
    return {
        hasTsConfig,
        noImplicitAny: options.noImplicitAny ?? options.strict ?? false,
        checkJs: options.checkJs ?? false,
        noUnusedParameters: options.noUnusedParameters ?? false
    };
}

/** Project options that change how code is *interpreted* (aliases, JSX, decorators), as opposed to how strictly it is judged. */
function interpretationOptions(project: ts.CompilerOptions | undefined): ts.CompilerOptions {
    if (!project) return {};
    const picked: Record<string, unknown> = {};
    for (const key of ['paths', 'pathsBasePath', 'baseUrl', 'jsx', 'jsxImportSource', 'esModuleInterop', 'allowSyntheticDefaultImports', 'experimentalDecorators', 'rootDirs']) {
        const value = (project as Record<string, unknown>)[key];
        if (value !== undefined) picked[key] = value;
    }
    return picked as ts.CompilerOptions;
}

export function createProgram(files: string[], projectOptions?: ts.CompilerOptions): ts.Program {
    const options = { ...PROGRAM_COMPILER_OPTIONS, ...interpretationOptions(projectOptions) };
    // The default host created implicitly by ts.createProgram does not set parent pointers on
    // parsed nodes, which breaks node.getStart()/getEnd()/getText() used throughout the rule
    // engine. Build the host explicitly with setParentNodes enabled.
    const host = ts.createCompilerHost(options, true);

    return ts.createProgram({
        rootNames: files,
        options,
        host
    });
}
