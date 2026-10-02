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
    checkJs: true,
    noEmit: true,
    skipLibCheck: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    noImplicitAny: true,
    strict: false
};

export function createProgram(files: string[]): ts.Program {
    // The default host created implicitly by ts.createProgram does not set parent pointers on
    // parsed nodes, which breaks node.getStart()/getEnd()/getText() used throughout the rule
    // engine. Build the host explicitly with setParentNodes enabled.
    const host = ts.createCompilerHost(PROGRAM_COMPILER_OPTIONS, true);

    return ts.createProgram({
        rootNames: files,
        options: PROGRAM_COMPILER_OPTIONS,
        host
    });
}
