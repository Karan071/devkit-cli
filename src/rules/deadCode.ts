import ts from 'typescript';
import path from 'node:path';
import type { RuleContext } from '../context';
import type { Finding } from '../types';
import { buildFinding } from '../finding';
import { isRuleEnabled } from '../config';
import { isTestFile } from '../discovery';
import { findNodeAtPosition, isStatementContainer, lineAndColumn } from '../ast/walk';

const UNUSED_DIAGNOSTIC_CODES = new Set([6133, 6192, 6196, 6198]);

function hasDynamicRequireHint(context: RuleContext, relativePath: string): boolean {
    for (const hint of context.moduleGraph.dynamicRequireHints) {
        if (hint === '.' || relativePath === hint || relativePath.startsWith(`${hint}/`)) return true;
    }
    return false;
}

function classifyUnusedDiagnostic(
    node: ts.Node,
    code: number
): { ruleId: string; title: string; fixAvailable: boolean } {
    if (code === 6192 || ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
        return { ruleId: 'DEAD002', title: 'Unused import', fixAvailable: true };
    }

    const importAncestor = ts.findAncestor(
        node,
        (ancestor) => ts.isImportSpecifier(ancestor) || ts.isNamespaceImport(ancestor) || ts.isImportClause(ancestor)
    );
    if (importAncestor) {
        return { ruleId: 'DEAD002', title: 'Unused import', fixAvailable: true };
    }

    if (code === 6196) {
        return { ruleId: 'DEAD007', title: 'Unused type', fixAvailable: false };
    }

    const parameterAncestor = ts.findAncestor(node, ts.isParameter);
    if (parameterAncestor) {
        return { ruleId: 'DEAD006', title: 'Unused parameter', fixAvailable: false };
    }

    const classAncestor = ts.findAncestor(node, ts.isClassDeclaration);
    if (classAncestor && classAncestor.name === node) {
        return { ruleId: 'DEAD005', title: 'Unused class', fixAvailable: false };
    }

    const functionAncestor = ts.findAncestor(node, ts.isFunctionDeclaration);
    if (functionAncestor && functionAncestor.name === node) {
        return { ruleId: 'DEAD004', title: 'Unused function', fixAvailable: false };
    }

    return { ruleId: 'DEAD003', title: 'Unused variable', fixAvailable: true };
}

/**
 * `const [value, setValue] = useState()` where only `value` is unused: deleting the variable alone leaves
 * the setter (and usually an effect that feeds it) behind, so it is not a safe mechanical fix.
 */
function pairedSetterName(node: ts.Node, sourceFile: ts.SourceFile): string | null {
    const element = ts.findAncestor(node, ts.isBindingElement);
    const pattern = element?.parent;
    if (!element || !pattern || !ts.isArrayBindingPattern(pattern)) return null;
    for (const sibling of pattern.elements) {
        if (sibling === element || !ts.isBindingElement(sibling) || !ts.isIdentifier(sibling.name)) continue;
        const name = sibling.name.text;
        let references = 0;
        const count = (current: ts.Node): void => {
            if (ts.isIdentifier(current) && current.text === name) references += 1;
            ts.forEachChild(current, count);
        };
        count(sourceFile);
        if (references > 1) return name;
    }
    return null;
}

/**
 * "After-used" semantics for parameters: `(req, res) => res.send()` must keep `req` because `res` is
 * positional, so a parameter is only dead when nothing after it in the list is used either.
 */
function isRequiredByLaterParameter(node: ts.Node, unusedStarts: Set<number>): boolean {
    const parameter = ts.findAncestor(node, ts.isParameter);
    const list = parameter?.parent;
    if (!parameter || !list || !('parameters' in list)) return false;
    const parameters = (list as ts.SignatureDeclarationBase).parameters;
    const position = parameters.indexOf(parameter);
    return parameters.slice(position + 1).some((later) => !unusedStarts.has(later.name.getStart()));
}

function isIntentionallyUnusedName(name: string): boolean {
    return name.startsWith('_');
}

function detectUnusedViaDiagnostics(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const file of context.files) {
        const sourceFile = context.program.getSourceFile(file);
        if (!sourceFile) {
            continue;
        }

        let diagnostics: readonly ts.Diagnostic[] = [];
        try {
            diagnostics = context.program.getSemanticDiagnostics(sourceFile);
        } catch {
            continue;
        }

        const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');
        const unusedStarts = new Set(diagnostics.filter((d) => d.start !== undefined && UNUSED_DIAGNOSTIC_CODES.has(d.code)).map((d) => d.start as number));
        const isTypeScript = /\.[cm]?tsx?$/i.test(file);

        for (const diagnostic of diagnostics) {
            if (diagnostic.start === undefined || !UNUSED_DIAGNOSTIC_CODES.has(diagnostic.code)) {
                continue;
            }

            const node = findNodeAtPosition(sourceFile, diagnostic.start);
            const classified = classifyUnusedDiagnostic(node, diagnostic.code);
            const { ruleId, title } = classified;
            const unusedName = sourceFile.text.slice(diagnostic.start, diagnostic.start + (diagnostic.length ?? 0));
            // A leading underscore is the standard way to say "unused on purpose".
            if ((ruleId === 'DEAD003' || ruleId === 'DEAD006') && isIntentionallyUnusedName(unusedName)) continue;
            if (ruleId === 'DEAD006') {
                if (isTypeScript && context.typeSettings?.hasTsConfig && !context.typeSettings.noUnusedParameters) continue;
                if (isRequiredByLaterParameter(node, unusedStarts)) continue;
            }
            const companion = ruleId === 'DEAD003' ? pairedSetterName(node, sourceFile) : null;
            const fixAvailable = classified.fixAvailable && !companion;

            if (!isRuleEnabled(context.config, ruleId)) {
                continue;
            }

            const { line, column } = lineAndColumn(sourceFile, diagnostic.start);
            const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');

            findings.push(
                buildFinding({
                    ruleId,
                    category: 'deadCode',
                    severity: ruleId === 'DEAD006' ? 'LOW' : 'MEDIUM',
                    confidence: 'CERTAIN',
                    file: relativePath,
                    line,
                    column,
                    message: title,
                    description: companion
                        ? `${message} Its companion "${companion}" is still referenced, so code that only feeds this value (effects, listeners) may become dead with it.`
                        : message,
                    // The compiler's own span names exactly what is unused (one specifier, not the whole import line).
                    evidence: sourceFile.text.slice(diagnostic.start, diagnostic.start + Math.min(diagnostic.length ?? node.getWidth(), 160)),
                    suggestion:
                        companion
                            ? `Remove "${companion}" and any effect or handler that only updates it, together with this value.`
                            : fixAvailable
                                ? 'Remove the unused declaration.'
                                : 'Remove it if truly unused, or export it if it is part of the public API.',
                    fixAvailable
                })
            );
        }
    }

    return findings;
}

function detectUnusedExports(context: RuleContext): Finding[] {
    if (!isRuleEnabled(context.config, 'DEAD009')) {
        return [];
    }

    const findings: Finding[] = [];
    const { moduleGraph } = context;
    const usedExportsByFile = new Map<string, Set<string>>();
    const fullyUsedFiles = new Set<string>();

    for (const [, imports] of moduleGraph.importsByFile) {
        for (const importInfo of imports) {
            if (!importInfo.resolved) {
                continue;
            }

            if (importInfo.hasNamespaceImport) {
                fullyUsedFiles.add(importInfo.resolved);
                continue;
            }

            if (!usedExportsByFile.has(importInfo.resolved)) {
                usedExportsByFile.set(importInfo.resolved, new Set());
            }
            const used = usedExportsByFile.get(importInfo.resolved)!;

            if (importInfo.hasDefaultImport) {
                used.add('default');
            }
            for (const name of importInfo.namedImports) {
                used.add(name);
            }
        }
    }

    for (const [, targets] of moduleGraph.reExportAllTargets) {
        for (const target of targets) {
            fullyUsedFiles.add(target);
        }
    }

    for (const [file, exports] of moduleGraph.exportsByFile) {
        if (exports.length === 0) continue;
        if (moduleGraph.entryPoints.has(file)) continue;
        const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');
        if (isTestFile(relativePath)) continue;
        if (fullyUsedFiles.has(file)) continue;

        const used = usedExportsByFile.get(file) ?? new Set<string>();
        const dynamicHint = hasDynamicRequireHint(context, relativePath);

        for (const exportInfo of exports) {
            if (used.has(exportInfo.name)) {
                continue;
            }

            findings.push(
                buildFinding({
                    ruleId: 'DEAD009',
                    category: 'deadCode',
                    severity: 'MEDIUM',
                    confidence: dynamicHint ? 'LOW' : 'MEDIUM',
                    file: relativePath,
                    line: exportInfo.line,
                    column: 1,
                    message: 'Unused export',
                    description: `Export "${exportInfo.name}" is not imported by any other file in the project.${dynamicHint ? ' A nearby dynamic require/import could not be resolved, so verify this manually.' : ''}`,
                    evidence: exportInfo.name,
                    suggestion: 'Remove the export or confirm it is part of a public API consumed outside this repository.',
                    fixAvailable: false
                })
            );
        }
    }

    return findings;
}

function detectUnusedFiles(context: RuleContext): Finding[] {
    if (!isRuleEnabled(context.config, 'DEAD010')) {
        return [];
    }

    const findings: Finding[] = [];
    const { moduleGraph } = context;

    for (const file of context.files) {
        const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');
        if (isTestFile(relativePath)) continue;
        if (moduleGraph.entryPoints.has(file)) continue;

        const incoming = moduleGraph.reverseEdges.get(file);
        if (incoming && incoming.size > 0) continue;
        const dynamicHint = hasDynamicRequireHint(context, relativePath);

        findings.push(
            buildFinding({
                ruleId: 'DEAD010',
                category: 'deadCode',
                severity: 'MEDIUM',
                confidence: dynamicHint ? 'LOW' : 'MEDIUM',
                file: relativePath,
                line: 1,
                column: 1,
                message: 'Unused file',
                description: `This file is never imported by any other file and is not a configured entry point.${dynamicHint ? ' A nearby dynamic require/import could not be resolved, so verify this manually.' : ''}`,
                evidence: relativePath,
                suggestion: 'Delete the file or wire it up as a reachable entry point.',
                fixAvailable: false
            })
        );
    }

    return findings;
}

function detectUnreachableStatements(context: RuleContext): Finding[] {
    if (!isRuleEnabled(context.config, 'DEAD011')) {
        return [];
    }

    const findings: Finding[] = [];

    for (const file of context.files) {
        const sourceFile = context.program.getSourceFile(file);
        if (!sourceFile) continue;

        const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');

        const checkStatementList = (statements: readonly ts.Statement[]): void => {
            let terminated = false;

            for (const statement of statements) {
                if (terminated) {
                    if (ts.isFunctionDeclaration(statement)) {
                        continue;
                    }

                    const { line, column } = lineAndColumn(sourceFile, statement.getStart());
                    findings.push(
                        buildFinding({
                            ruleId: 'DEAD011',
                            category: 'deadCode',
                            severity: 'MEDIUM',
                            confidence: 'CERTAIN',
                            file: relativePath,
                            line,
                            column,
                            message: 'Unreachable statement',
                            description: 'Code following a return, throw, break, or continue statement can never execute.',
                            evidence: statement.getText().slice(0, 160),
                            suggestion: 'Remove the unreachable code.',
                            fixAvailable: true
                        })
                    );
                    break;
                }

                if (
                    ts.isReturnStatement(statement) ||
                    ts.isThrowStatement(statement) ||
                    ts.isBreakStatement(statement) ||
                    ts.isContinueStatement(statement)
                ) {
                    terminated = true;
                }
            }
        };

        const visit = (node: ts.Node): void => {
            if (isStatementContainer(node)) {
                checkStatementList(node.statements);
            }
            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
    }

    return findings;
}

export function runDeadCodeRules(context: RuleContext): Finding[] {
    return [
        ...detectUnusedViaDiagnostics(context),
        ...detectUnusedExports(context),
        ...detectUnusedFiles(context),
        ...detectUnreachableStatements(context)
    ];
}
