import path from 'node:path';
import ts from 'typescript';
import type { RuleContext } from '../context';
import type { Finding } from '../types';
import { buildFinding } from '../finding';
import { isRuleEnabled } from '../config';
import { lineAndColumn } from '../ast/walk';

function collectLocalAsyncNames(sourceFile: ts.SourceFile): Set<string> {
    const names = new Set<string>();

    const hasAsyncModifier = (node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction): boolean =>
        (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false;

    const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name && hasAsyncModifier(node)) {
            names.add(node.name.text);
        }

        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            const init = node.initializer;
            if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && hasAsyncModifier(init)) {
                names.add(node.name.text);
            }
        }

        ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return names;
}

export function runErrorHandlingRules(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const file of context.files) {
        const sourceFile = context.program.getSourceFile(file);
        if (!sourceFile) continue;

        const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');
        const asyncNames = collectLocalAsyncNames(sourceFile);

        const visit = (node: ts.Node): void => {
            if (ts.isCatchClause(node)) {
                const statements = node.block.statements;

                if (isRuleEnabled(context.config, 'ERR001') && statements.length === 0) {
                    const { line, column } = lineAndColumn(sourceFile, node.getStart());
                    findings.push(
                        buildFinding({
                            ruleId: 'ERR001',
                            category: 'errorHandling',
                            severity: 'MEDIUM',
                            confidence: 'CERTAIN',
                            file: relativePath,
                            line,
                            column,
                            message: 'Empty catch block',
                            description: 'An exception is caught and silently discarded.',
                            evidence: node.getText().slice(0, 160),
                            suggestion: 'Handle the error, log it, or document why it is intentionally ignored.',
                            fixAvailable: false
                        })
                    );
                }

                if (isRuleEnabled(context.config, 'ERR002') && statements.length === 1 && ts.isThrowStatement(statements[0])) {
                    const throwStatement = statements[0];
                    const catchVarName = node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)
                        ? node.variableDeclaration.name.text
                        : undefined;
                    const rethrowsSameValue =
                        !throwStatement.expression ||
                        (catchVarName && ts.isIdentifier(throwStatement.expression) && throwStatement.expression.text === catchVarName);

                    if (rethrowsSameValue) {
                        const { line, column } = lineAndColumn(sourceFile, node.getStart());
                        findings.push(
                            buildFinding({
                                ruleId: 'ERR002',
                                category: 'errorHandling',
                                severity: 'LOW',
                                confidence: 'HIGH',
                                file: relativePath,
                                line,
                                column,
                                message: 'Catch-and-rethrow without modification',
                                description: 'The catch block only rethrows the original error, adding no value.',
                                evidence: node.getText().slice(0, 160),
                                suggestion: 'Remove the try/catch, or add meaningful handling (logging, wrapping, recovery).',
                                fixAvailable: false
                            })
                        );
                    }
                }
            }

            if (isRuleEnabled(context.config, 'ERR003') && ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
                const call = node.expression;
                if (ts.isIdentifier(call.expression) && asyncNames.has(call.expression.text)) {
                    const { line, column } = lineAndColumn(sourceFile, node.getStart());
                    findings.push(
                        buildFinding({
                            ruleId: 'ERR003',
                            category: 'errorHandling',
                            severity: 'MEDIUM',
                            confidence: 'MEDIUM',
                            file: relativePath,
                            line,
                            column,
                            message: 'Floating promise',
                            description: `The result of calling async function "${call.expression.text}" is neither awaited nor handled.`,
                            evidence: node.getText().slice(0, 160),
                            suggestion: 'Add await, or explicitly handle rejection (.catch) or discard intent (void).',
                            fixAvailable: false
                        })
                    );
                }
            }

            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
    }

    return findings;
}
