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

export function runJavaScriptRules(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const file of context.files) {
        const sourceFile = context.program.getSourceFile(file);
        if (!sourceFile) continue;

        const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');

        const visit = (node: ts.Node): void => {
            if (
                isRuleEnabled(context.config, 'JS001') &&
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
                !isNullLiteral(node.right)
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
