import path from 'node:path';
import ts from 'typescript';
import type { RuleContext } from '../context';
import type { Finding } from '../types';
import { buildFinding } from '../finding';
import { isRuleEnabled } from '../config';
import { lineAndColumn } from '../ast/walk';

const LOOSE_EQUALITY_OPERATORS = new Set([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

function isNullLiteral(node: ts.Node): boolean {
    return node.kind === ts.SyntaxKind.NullKeyword;
}

/**
 * Comparisons where `==` and `===` cannot differ, so the loose form is an idiom and not a bug:
 * `typeof x != "undefined"` (a typeof result is always a string), and `x == undefined` / `x == void 0`, which
 * is the same null-or-undefined check as `x == null`.
 */
function isCoercionFreeComparison(node: ts.BinaryExpression): boolean {
    const isTypeof = (expression: ts.Expression): boolean => ts.isTypeOfExpression(expression);
    const isUndefined = (expression: ts.Expression): boolean =>
        (ts.isIdentifier(expression) && expression.text === 'undefined') || ts.isVoidExpression(expression);
    return isTypeof(node.left) || isTypeof(node.right) || isUndefined(node.left) || isUndefined(node.right);
}

/**
 * A codebase written almost entirely with `var` (Express, most pre-2015 libraries) made that choice as a
 * style; flagging each declaration buries the real signal. Only a clear, large-scale majority counts -
 * a few `var`s in an otherwise modern project are still worth a finding.
 */
function usesLegacyVarStyle(context: RuleContext): boolean {
    let vars = 0;
    let blockScoped = 0;
    for (const file of context.files) {
        const sourceFile = context.program.getSourceFile(file);
        if (!sourceFile) continue;
        const count = (node: ts.Node): void => {
            if (ts.isVariableStatement(node)) {
                if ((node.declarationList.flags & ts.NodeFlags.BlockScoped) === 0) vars += 1;
                else blockScoped += 1;
            }
            ts.forEachChild(node, count);
        };
        count(sourceFile);
    }
    return vars >= 25 && vars / (vars + blockScoped) >= 0.9;
}

export function runJavaScriptRules(context: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const legacyVarStyle = isRuleEnabled(context.config, 'JS001') && usesLegacyVarStyle(context);

    for (const file of context.files) {
        const sourceFile = context.program.getSourceFile(file);
        if (!sourceFile) continue;

        const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');

        const visit = (node: ts.Node): void => {
            if (
                isRuleEnabled(context.config, 'JS001') &&
                !legacyVarStyle &&
                ts.isVariableStatement(node) &&
                (node.declarationList.flags & ts.NodeFlags.BlockScoped) === 0
            ) {
                const { line, column } = lineAndColumn(sourceFile, node.getStart());
                findings.push(
                    buildFinding({
                        ruleId: 'JS001',
                        category: 'hygiene',
                        severity: 'LOW',
                        confidence: 'CERTAIN',
                        file: relativePath,
                        line,
                        column,
                        message: "'var' declaration",
                        description: 'var is function-scoped and hoisted, which commonly causes bugs.',
                        evidence: node.getText().slice(0, 160),
                        suggestion: 'Use let or const instead.',
                        fixAvailable: false
                    })
                );
            }

            if (
                isRuleEnabled(context.config, 'JS002') &&
                ts.isBinaryExpression(node) &&
                LOOSE_EQUALITY_OPERATORS.has(node.operatorToken.kind) &&
                !isNullLiteral(node.left) &&
                !isNullLiteral(node.right) &&
                !isCoercionFreeComparison(node)
            ) {
                const { line, column } = lineAndColumn(sourceFile, node.getStart());
                findings.push(
                    buildFinding({
                        ruleId: 'JS002',
                        category: 'hygiene',
                        severity: 'LOW',
                        confidence: 'CERTAIN',
                        file: relativePath,
                        line,
                        column,
                        message: 'Loose equality',
                        description: 'Loose equality performs implicit type coercion, which can hide bugs.',
                        evidence: node.getText().slice(0, 160),
                        suggestion: 'Use === or !== instead.',
                        fixAvailable: false
                    })
                );
            }

            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
    }

    return findings;
}
