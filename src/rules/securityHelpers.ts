import ts from 'typescript';

/** Facts about call sites shared by the pattern-based security checks and the taint analysis. */
export const EXEC_FUNCTION_NAMES = new Set(['exec', 'execSync']);
export const SHELL_FUNCTION_NAMES = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync']);
// Methods that run a SQL string: driver and query-builder calls, and the ORM escape hatches that skip parameterization.
export const SQL_FUNCTION_NAMES = new Set(['query', 'execute', 'raw', '$queryRawUnsafe', '$executeRawUnsafe', 'queryRawUnsafe', 'executeRawUnsafe']);
export const FILE_FUNCTION_NAMES = new Set(['readFile', 'readFileSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createReadStream', 'createWriteStream', 'unlink', 'unlinkSync', 'open', 'openSync', 'stat', 'statSync', 'access', 'accessSync']);

export function calleeName(expression: ts.Expression): string | null {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    return null;
}

const CHILD_PROCESS_MODULE = /(?:^|[\\/])child_process(?:\.d\.[cm]?ts|\.[cm]?js)?$/;

export function declarationOrigins(checker: ts.TypeChecker, expression: ts.Expression): { files: string[]; modules: string[] } {
    const callee = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    let symbol = checker.getSymbolAtLocation(callee);
    const modules: string[] = [];
    // Follow `import { exec as run }` / `const { exec } = require('child_process')` back to the module.
    for (const declaration of symbol?.declarations ?? []) {
        const importDeclaration = ts.findAncestor(declaration, ts.isImportDeclaration);
        if (importDeclaration && ts.isStringLiteral(importDeclaration.moduleSpecifier)) modules.push(importDeclaration.moduleSpecifier.text);
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
            const required = ts.isCallExpression(declaration.initializer) ? declaration.initializer : undefined;
            const arg = required?.arguments[0];
            if (required && ts.isIdentifier(required.expression) && required.expression.text === 'require' && arg && ts.isStringLiteral(arg)) modules.push(arg.text);
        }
    }
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
        try { symbol = checker.getAliasedSymbol(symbol); } catch { /* unresolved alias: keep what we have */ }
    }
    return { files: (symbol?.declarations ?? []).map((declaration) => declaration.getSourceFile().fileName), modules };
}

/**
 * Whether the call can be the Node child_process API. Decided from where the callee is declared, not
 * from its name: `/re/.exec(s)` and `db.exec(sql)` share the name `exec` but not the declaration.
 * `module.exec` on a namespace import (`cp.exec`) is resolved through the namespace's module.
 */
export function mayBeShellExecution(checker: ts.TypeChecker, call: ts.CallExpression, importedModules: Set<string>): boolean {
    const target = call.expression;
    if (ts.isPropertyAccessExpression(target)) {
        let receiverType: ts.Type | undefined;
        try { receiverType = checker.getTypeAtLocation(target.expression); } catch { receiverType = undefined; }
        const receiverName = receiverType?.getSymbol()?.getName();
        if (receiverName === 'RegExp' || (receiverType && (receiverType.flags & ts.TypeFlags.StringLike))) return false;
        if (ts.isRegularExpressionLiteral(target.expression)) return false;

        const receiver = ts.isIdentifier(target.expression) ? checker.getSymbolAtLocation(target.expression) : undefined;
        for (const declaration of receiver?.declarations ?? []) {
            const importDeclaration = ts.findAncestor(declaration, ts.isImportDeclaration);
            if (importDeclaration && ts.isStringLiteral(importDeclaration.moduleSpecifier)) {
                return /^(?:node:)?child_process$/.test(importDeclaration.moduleSpecifier.text);
            }
        }
    }

    const origins = declarationOrigins(checker, target);
    if (origins.files.some((file) => CHILD_PROCESS_MODULE.test(file))) return true;
    if (origins.modules.some((module) => /^(?:node:)?child_process$/.test(module))) return true;
    // Nothing resolved (untyped code): fall back to whether the file pulls in child_process at all.
    return origins.files.length === 0 && origins.modules.length === 0 && (importedModules.has('child_process') || importedModules.has('node:child_process'));
}

/** The name a callee was exported under, so `import { exec as run }` still reads as `exec`. */
export function importedCalleeName(checker: ts.TypeChecker, expression: ts.Expression): string | null {
    if (!ts.isIdentifier(expression)) return null;
    for (const declaration of checker.getSymbolAtLocation(expression)?.declarations ?? []) {
        if (ts.isImportSpecifier(declaration)) return (declaration.propertyName ?? declaration.name).text;
        if (ts.isBindingElement(declaration) && ts.isIdentifier(declaration.name)) {
            const property = declaration.propertyName ?? declaration.name;
            if (ts.isIdentifier(property)) return property.text;
        }
    }
    return null;
}
