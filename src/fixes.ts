import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { Finding } from './types';
import { loadScannedTsConfig } from './moduleResolution';

export type FixRuleId = 'DEAD002' | 'HYGIENE001' | 'JS001';

export interface PlannedFix {
    ruleId: FixRuleId;
    line: number;
    description: string;
}

export interface FilePlan {
    relativePath: string;
    absolutePath: string;
    original: string;
    updated: string;
    fixes: PlannedFix[];
}

export interface FixPlan {
    files: FilePlan[];
    /** Files with fixable findings where nothing was changed, and why. */
    skipped: Array<{ relativePath: string; reason: string }>;
}

const FIXABLE_RULES = new Set<string>(['DEAD002', 'HYGIENE001', 'JS001']);

interface Edit {
    start: number;
    end: number;
    replacement: string;
}

class Project {
    private readonly versions = new Map<string, number>();
    private readonly overlay = new Map<string, string>();
    readonly service: ts.LanguageService;

    constructor(private readonly roots: string[], options: ts.CompilerOptions) {
        const host: ts.LanguageServiceHost = {
            getScriptFileNames: () => this.roots,
            getScriptVersion: (file) => String(this.versions.get(file) ?? 0),
            getScriptSnapshot: (file) => {
                const text = this.overlay.get(file) ?? ts.sys.readFile(file);
                return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
            },
            getCurrentDirectory: () => process.cwd(),
            getCompilationSettings: () => options,
            getDefaultLibFileName: (settings) => ts.getDefaultLibFilePath(settings),
            fileExists: ts.sys.fileExists,
            readFile: (file) => this.overlay.get(file) ?? ts.sys.readFile(file),
            readDirectory: ts.sys.readDirectory,
            directoryExists: ts.sys.directoryExists,
            getDirectories: ts.sys.getDirectories
        };
        this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
    }

    text(file: string): string {
        return this.overlay.get(file) ?? ts.sys.readFile(file) ?? '';
    }

    set(file: string, text: string): void {
        this.overlay.set(file, text);
        this.versions.set(file, (this.versions.get(file) ?? 0) + 1);
    }

    sourceFile(file: string): ts.SourceFile {
        const sourceFile = this.service.getProgram()?.getSourceFile(file);
        if (!sourceFile) throw new Error(`Cannot read ${file}`);
        return sourceFile;
    }

    errorCount(file: string): number {
        return this.service.getSyntacticDiagnostics(file).length + this.service.getSemanticDiagnostics(file).filter((d) => d.category === ts.DiagnosticCategory.Error).length;
    }
}

function applyEdits(text: string, edits: Edit[]): string {
    return [...edits].sort((a, b) => b.start - a.start).reduce((current, edit) => current.slice(0, edit.start) + edit.replacement + current.slice(edit.end), text);
}

/** The range of a whole-line statement, including its newline, so no blank line is left behind. */
function wholeLineRange(sourceFile: ts.SourceFile, node: ts.Node): [number, number] {
    const text = sourceFile.text;
    let start = node.getStart(sourceFile);
    let end = node.getEnd();
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    if (text.slice(lineStart, start).trim() === '') start = lineStart;
    const rest = /^[ \t]*(?:\r?\n)?/.exec(text.slice(end))?.[0] ?? '';
    if (start === lineStart) end += rest.length;
    return [start, end];
}

/**
 * Removes exactly the import bindings the compiler reported as unused (`positions` are the starts of its spans).
 * The text around them is untouched: an import that loses every binding disappears with its line, and one that
 * loses some keeps its own layout, commas and trailing comma.
 */
function unusedImportEdits(sourceFile: ts.SourceFile, positions: Set<number>): Array<Edit & { line: number }> {
    const edits: Array<Edit & { line: number }> = [];
    const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
        const clause = statement.importClause;
        const named = clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? [...clause.namedBindings.elements] : [];
        const namespace = clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings : undefined;
        const bindings: ts.Node[] = [...(clause.name ? [clause.name] : []), ...(namespace ? [namespace] : []), ...named];
        const flagged = (node: ts.Node) => positions.has(node.getStart(sourceFile));

        if (positions.has(statement.getStart(sourceFile)) || (bindings.length > 0 && bindings.every(flagged))) {
            const [start, end] = wholeLineRange(sourceFile, statement);
            edits.push({ start, end, replacement: '', line: lineOf(statement) });
            continue;
        }

        if (clause.name && flagged(clause.name) && clause.namedBindings) {
            edits.push({ start: clause.name.getStart(sourceFile), end: clause.namedBindings.getStart(sourceFile), replacement: '', line: lineOf(clause.name) });
        }
        named.forEach((element, index) => {
            if (!flagged(element)) return;
            const next = named.slice(index + 1).find((later) => !flagged(later));
            const previous = [...named.slice(0, index)].reverse().find((earlier) => !flagged(earlier));
            // Delete up to the next surviving element so its indentation is kept; if this runs to the end, delete back to the last survivor.
            if (next && named[index + 1] === next) edits.push({ start: element.getStart(sourceFile), end: next.getStart(sourceFile), replacement: '', line: lineOf(element) });
            else if (previous && named[index - 1] === previous) edits.push({ start: previous.getEnd(), end: element.getEnd(), replacement: '', line: lineOf(element) });
            else edits.push({ start: element.getStart(sourceFile), end: element.getEnd() + (/^\s*,/.exec(sourceFile.text.slice(element.getEnd()))?.[0].length ?? 0), replacement: '', line: lineOf(element) });
        });
    }

    // Edits from neighbouring flagged elements can touch; merge-safe only when they do not overlap.
    return edits;
}

/** `console.log(...)`/`console.debug(...)` or `debugger` as a whole statement, whose removal cannot change what else runs. */
function debugStatementEdits(sourceFile: ts.SourceFile, findingLines: Set<number>): Array<Edit & { line: number }> {
    const edits: Array<Edit & { line: number }> = [];
    const visit = (node: ts.Node): void => {
        const isDebugger = ts.isDebuggerStatement(node);
        const isConsole = ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.expression) &&
            ts.isIdentifier(node.expression.expression.expression) && node.expression.expression.expression.text === 'console' &&
            ['log', 'debug'].includes(node.expression.expression.name.text);
        if (isDebugger || isConsole) {
            const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
            // Only statements in a list: `if (x) console.log(y)` would change meaning if the statement vanished.
            const statements = ts.isBlock(node.parent) || ts.isSourceFile(node.parent) || ts.isModuleBlock(node.parent) ? node.parent.statements
                : ts.isCaseClause(node.parent) || ts.isDefaultClause(node.parent) ? node.parent.statements : undefined;
            // Not the only statement of a block: removing it would leave an empty `else {}` or `catch {}` behind.
            const soleStatement = !!statements && statements.length === 1 && !ts.isSourceFile(node.parent);
            if (statements && !soleStatement && findingLines.has(line)) {
                const [start, end] = wholeLineRange(sourceFile, node);
                edits.push({ start, end, replacement: '', line });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return edits;
}

function isWrite(identifier: ts.Identifier): boolean {
    const parent = identifier.parent;
    if (ts.isBinaryExpression(parent) && parent.left === identifier) {
        return parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    }
    if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) return true;
    if ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === identifier) return true;
    // `[a, b] = ...` / `({ a } = ...)`: the identifier sits inside a destructuring assignment target.
    for (let current: ts.Node = identifier; current.parent; current = current.parent) {
        const up = current.parent;
        if (ts.isBinaryExpression(up) && up.left === current && up.operatorToken.kind === ts.SyntaxKind.EqualsToken && current !== identifier) return true;
        if (!(ts.isArrayLiteralExpression(up) || ts.isObjectLiteralExpression(up) || ts.isPropertyAssignment(up) || ts.isShorthandPropertyAssignment(up) || ts.isSpreadElement(up) || ts.isSpreadAssignment(up))) break;
    }
    return false;
}

function enclosingFunction(node: ts.Node): ts.Node {
    return ts.findAncestor(node, (n) => ts.isFunctionLike(n) || ts.isSourceFile(n)) as ts.Node;
}

/**
 * `var x = ...` at the top level of a function or module becomes `const`/`let` only when that cannot change behavior:
 * one declaration of the name, every use after it and not inside a hoisted function declaration (which could run
 * before the declaration does), and a module (not a script, where `var` creates a global).
 */
function varEdits(sourceFile: ts.SourceFile, checker: ts.TypeChecker, findingLines: Set<number>): Array<Edit & { line: number }> {
    const edits: Array<Edit & { line: number }> = [];
    const isModule = sourceFile.statements.some((s) => ts.isImportDeclaration(s) || ts.isExportDeclaration(s) || ts.isExportAssignment(s) || ts.isImportEqualsDeclaration(s) ||
        (ts.canHaveModifiers(s) && ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)));

    const visit = (node: ts.Node): void => {
        if (ts.isVariableStatement(node) && (node.declarationList.flags & ts.NodeFlags.BlockScoped) === 0) {
            const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
            const scope = enclosingFunction(node);
            const atTopOfScope = ts.isSourceFile(node.parent) || (ts.isBlock(node.parent) && ts.isFunctionLike(node.parent.parent) && node.parent.parent === scope);
            if (findingLines.has(line) && atTopOfScope && (!ts.isSourceFile(scope) || isModule)) {
                const declarations = node.declarationList.declarations;
                let safe = declarations.every((declaration) => ts.isIdentifier(declaration.name));
                let needsLet = declarations.some((declaration) => !declaration.initializer);

                for (const declaration of safe ? declarations : []) {
                    const symbol = checker.getSymbolAtLocation(declaration.name);
                    if (!symbol || (symbol.declarations?.length ?? 0) !== 1) { safe = false; break; }
                    const search = (current: ts.Node): void => {
                        if (!safe) return;
                        if (ts.isIdentifier(current) && current !== declaration.name && current.text === (declaration.name as ts.Identifier).text && checker.getSymbolAtLocation(current) === symbol) {
                            const owner = enclosingFunction(current);
                            const inHoistedDeclaration = owner !== scope && ts.isFunctionDeclaration(owner);
                            if (current.getStart(sourceFile) < node.getEnd() || inHoistedDeclaration) safe = false;
                            else if (isWrite(current)) needsLet = true;
                        }
                        ts.forEachChild(current, search);
                    };
                    search(scope);
                }

                if (safe) {
                    const keyword = node.declarationList.getChildAt(0, sourceFile);
                    edits.push({ start: keyword.getStart(sourceFile), end: keyword.getEnd(), replacement: needsLet ? 'let' : 'const', line });
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return edits;
}

/**
 * Works out the safe, mechanical fixes for the given findings without touching the disk. Each file's edits are
 * applied in memory and the file is re-checked; if that adds a compile error the file's edits are dropped.
 */
export function planFixes(projectRoot: string, findings: Finding[]): FixPlan {
    const linesByFile = new Map<string, Map<FixRuleId, Array<{ line: number; column: number }>>>();
    for (const finding of findings) {
        if (!FIXABLE_RULES.has(finding.ruleId) || (finding.confidence !== 'CERTAIN' && finding.confidence !== 'HIGH')) continue;
        const byRule = linesByFile.get(finding.file) ?? new Map<FixRuleId, Array<{ line: number; column: number }>>();
        const lines = byRule.get(finding.ruleId as FixRuleId) ?? [];
        lines.push({ line: finding.line, column: finding.column });
        byRule.set(finding.ruleId as FixRuleId, lines);
        linesByFile.set(finding.file, byRule);
    }

    const plan: FixPlan = { files: [], skipped: [] };
    const absolute = (relative: string) => path.resolve(projectRoot, relative);
    const roots = [...linesByFile.keys()].map(absolute).filter((file) => /\.[cm]?[jt]sx?$/.test(file));
    if (roots.length === 0) return plan;

    const project = new Project(roots, { ...loadScannedTsConfig(projectRoot), noEmit: true, allowJs: true, checkJs: false });

    for (const [relativePath, byRule] of [...linesByFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const file = absolute(relativePath);
        if (!roots.includes(file)) continue;
        const original = project.text(file);
        const baseline = project.errorCount(file);
        const fixes: PlannedFix[] = [];

        // Every kind of edit is located against the original text, then all are applied in one pass.
        const sourceFile = project.sourceFile(file);
        const importEdits = byRule.has('DEAD002')
            ? unusedImportEdits(sourceFile, new Set(byRule.get('DEAD002')!.map(({ line, column }) => sourceFile.getPositionOfLineAndCharacter(line - 1, column - 1))))
            : [];
        const linesOf = (rule: FixRuleId) => new Set((byRule.get(rule) ?? []).map(({ line }) => line));
        const debugEdits = byRule.has('HYGIENE001') ? debugStatementEdits(sourceFile, linesOf('HYGIENE001')) : [];
        const varFixes = byRule.has('JS001') ? varEdits(sourceFile, project.service.getProgram()!.getTypeChecker(), linesOf('JS001')) : [];

        const all: Edit[] = [...importEdits, ...debugEdits, ...varFixes];
        const sorted = [...all].sort((a, b) => a.start - b.start);
        // Overlapping edits cannot all be applied; skip the file rather than guess which to keep.
        const overlapping = sorted.some((edit, index) => index > 0 && edit.start < sorted[index - 1].end);
        let current = original;
        if (!overlapping && all.length > 0) {
            current = applyEdits(original, all);
            for (const edit of importEdits) fixes.push({ ruleId: 'DEAD002', line: edit.line, description: 'Remove unused import' });
            for (const edit of debugEdits) fixes.push({ ruleId: 'HYGIENE001', line: edit.line, description: 'Remove debug statement' });
            for (const edit of varFixes) fixes.push({ ruleId: 'JS001', line: edit.line, description: `Replace var with ${edit.replacement}` });
        }

        if (current === original) {
            plan.skipped.push({ relativePath, reason: 'no change is provably safe here' });
            project.set(file, original);
            continue;
        }

        project.set(file, current);
        const after = project.errorCount(file);
        if (after > baseline) {
            plan.skipped.push({ relativePath, reason: `the fixes would add ${after - baseline} compile error(s)` });
            project.set(file, original);
            continue;
        }
        plan.files.push({ relativePath, absolutePath: file, original, updated: current, fixes: fixes.sort((a, b) => a.line - b.line) });
    }
    return plan;
}

export function writeFixes(plan: FixPlan): void {
    for (const file of plan.files) fs.writeFileSync(file.absolutePath, file.updated);
}
