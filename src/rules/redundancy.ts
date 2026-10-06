import path from 'node:path';
import ts from 'typescript';
import type { RuleContext } from '../context';
import type { Finding } from '../types';
import { buildFinding } from '../finding';
import { isRuleEnabled } from '../config';
import { lineAndColumn } from '../ast/walk';

const LOOSE_EQUALITY_OPERATORS = new Set([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);
const STRICT_EQUALITY_OPERATORS = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken]);

function isBooleanLiteral(node: ts.Node): boolean {
    return node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword;
}

export function runRedundancyRules(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const file of context.files) {
        const sourceFile = context.program.getSourceFile(file);
        if (!sourceFile) continue;

        const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');

        const visit = (node: ts.Node): void => {
            if (
                isRuleEnabled(context.config, 'REDUNDANT001') &&
                ts.isBinaryExpression(node) &&
                (LOOSE_EQUALITY_OPERATORS.has(node.operatorToken.kind) || STRICT_EQUALITY_OPERATORS.has(node.operatorToken.kind)) &&
                (isBooleanLiteral(node.left) || isBooleanLiteral(node.right))
            ) {
                const comparedExpression = isBooleanLiteral(node.left) ? node.right : node.left;
                const comparedType = context.program.getTypeChecker().getTypeAtLocation(comparedExpression);
                // `x === true` is only redundant when x is certainly a boolean. For any/unknown (untyped JS, missing
                // declarations) or unions with null/undefined/other members it distinguishes real cases.
                const members = comparedType.isUnion() ? comparedType.types : [comparedType];
                if (members.some((member) => (member.flags & ts.TypeFlags.BooleanLike) === 0)) {
                    ts.forEachChild(node, visit);
                    return;
                }
                const { line, column } = lineAndColumn(sourceFile, node.getStart());
                findings.push(
                    buildFinding({
                        ruleId: 'REDUNDANT001',
                        category: 'redundantLogic',
                        severity: 'LOW',
                        confidence: 'CERTAIN',
                        file: relativePath,
                        line,
                        column,
                        message: 'Redundant boolean comparison',
                        description: 'Comparing a value directly to true/false is unnecessary.',
                        evidence: node.getText().slice(0, 160),
                        suggestion: 'Use the expression directly, negating it with ! if needed.',
                        fixAvailable: false
                    })
                );
            }

            if (
                isRuleEnabled(context.config, 'REDUNDANT002') &&
                ts.isIfStatement(node) &&
                (node.expression.kind === ts.SyntaxKind.TrueKeyword || node.expression.kind === ts.SyntaxKind.FalseKeyword)
            ) {
                const { line, column } = lineAndColumn(sourceFile, node.getStart());
                findings.push(
                    buildFinding({
                        ruleId: 'REDUNDANT002',
                        category: 'redundantLogic',
                        severity: 'MEDIUM',
                        confidence: 'CERTAIN',
                        file: relativePath,
                        line,
                        column,
                        message: 'Impossible condition',
                        description: `The condition is a literal ${node.expression.kind === ts.SyntaxKind.TrueKeyword ? 'true' : 'false'}, so one branch can never execute.`,
                        evidence: node.getText().slice(0, 160),
                        suggestion: 'Remove the dead branch or the conditional entirely.',
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
