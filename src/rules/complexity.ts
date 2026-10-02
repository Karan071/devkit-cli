import path from 'node:path';
import ts from 'typescript';
import type { RuleContext } from '../context';
import type { Finding, Severity } from '../types';
import { buildFinding } from '../finding';
import { getRuleThreshold, isRuleEnabled } from '../config';
import { getFunctionName, isFunctionLike, lineAndColumn } from '../ast/walk';

export interface FunctionMetric {
    name: string;
    file: string;
    line: number;
    lines: number;
    cyclomatic: number;
    cognitive: number;
    parameters: number;
    nestingDepth: number;
    statementCount: number;
    returnCount: number;
}

const DEFAULT_THRESHOLDS = {
    COMPLEX001: 10,
    COMPLEX002: 15,
    COMPLEX003: 100,
    COMPLEX004: 5,
    COMPLEX005: 4
};

function severityForOverage(value: number, max: number): Severity {
    return value >= max * 2 ? 'HIGH' : 'MEDIUM';
}

function computeFunctionMetrics(node: ts.FunctionLikeDeclaration, sourceFile: ts.SourceFile): Omit<FunctionMetric, 'name' | 'file'> {
    let cyclomatic = 1;
    let cognitive = 0;
    let statementCount = 0;
    let returnCount = 0;
    let maxNesting = 0;

    const visit = (current: ts.Node, nestingLevel: number, isElseIfChain: boolean): void => {
        if (current !== node && isFunctionLike(current)) {
            return;
        }

        if (ts.isStatement(current)) {
            statementCount += 1;
        }

        if (ts.isReturnStatement(current)) {
            returnCount += 1;
        }

        if (ts.isIfStatement(current)) {
            maxNesting = Math.max(maxNesting, nestingLevel + 1);
            cyclomatic += 1;
            cognitive += isElseIfChain ? 1 : 1 + nestingLevel;

            visit(current.thenStatement, nestingLevel + 1, false);
            if (current.elseStatement) {
                const elseIsIf = ts.isIfStatement(current.elseStatement);
                visit(current.elseStatement, nestingLevel + (elseIsIf ? 0 : 1), elseIsIf);
            }
            return;
        }

        if (
            ts.isForStatement(current) ||
            ts.isForInStatement(current) ||
            ts.isForOfStatement(current) ||
            ts.isWhileStatement(current) ||
            ts.isDoStatement(current)
        ) {
            maxNesting = Math.max(maxNesting, nestingLevel + 1);
            cyclomatic += 1;
            cognitive += 1 + nestingLevel;
            ts.forEachChild(current, (child) => visit(child, nestingLevel + 1, false));
            return;
        }

        if (ts.isSwitchStatement(current)) {
            maxNesting = Math.max(maxNesting, nestingLevel + 1);
            cognitive += 1 + nestingLevel;
            for (const clause of current.caseBlock.clauses) {
                if (ts.isCaseClause(clause)) {
                    cyclomatic += 1;
                }
                for (const statement of clause.statements) {
                    visit(statement, nestingLevel + 1, false);
                }
            }
            return;
        }

        if (ts.isCatchClause(current)) {
            maxNesting = Math.max(maxNesting, nestingLevel + 1);
            cyclomatic += 1;
            cognitive += 1 + nestingLevel;
            ts.forEachChild(current, (child) => visit(child, nestingLevel + 1, false));
            return;
        }

        if (ts.isConditionalExpression(current)) {
            cyclomatic += 1;
            cognitive += 1 + nestingLevel;
            visit(current.condition, nestingLevel, false);
            visit(current.whenTrue, nestingLevel + 1, false);
            visit(current.whenFalse, nestingLevel + 1, false);
            return;
        }

        if (ts.isBinaryExpression(current)) {
            const operator = current.operatorToken.kind;
            const isLogical =
                operator === ts.SyntaxKind.AmpersandAmpersandToken ||
                operator === ts.SyntaxKind.BarBarToken ||
                operator === ts.SyntaxKind.QuestionQuestionToken;

            if (isLogical) {
                cyclomatic += 1;
                const parent = current.parent;
                const sameChainAsParent = ts.isBinaryExpression(parent) && parent.operatorToken.kind === operator;
                if (!sameChainAsParent) {
                    cognitive += 1;
                }
            }
        }

        ts.forEachChild(current, (child) => visit(child, nestingLevel, false));
    };

    const body = (node as ts.FunctionLikeDeclaration).body;
    if (body) {
        visit(body, 0, false);
    }

    const start = lineAndColumn(sourceFile, node.getStart()).line;
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

    return {
        line: start,
        lines: end - start + 1,
        cyclomatic,
        cognitive,
        parameters: node.parameters.length,
        nestingDepth: maxNesting,
        statementCount,
        returnCount
    };
}

export function collectFunctionMetrics(context: RuleContext): FunctionMetric[] {
    const metrics: FunctionMetric[] = [];

    for (const file of context.files) {
        const sourceFile = context.program.getSourceFile(file);
        if (!sourceFile) continue;

        const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');

        const visit = (node: ts.Node): void => {
            if (isFunctionLike(node) && node.body) {
                const computed = computeFunctionMetrics(node, sourceFile);
                metrics.push({ name: getFunctionName(node), file: relativePath, ...computed });
            }
            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
    }

    return metrics;
}

export function runComplexityRules(context: RuleContext, functionMetrics: FunctionMetric[]): Finding[] {
    const findings: Finding[] = [];
    const cyclomaticMax = getRuleThreshold(context.config, 'COMPLEX001', DEFAULT_THRESHOLDS.COMPLEX001);
    const cognitiveMax = getRuleThreshold(context.config, 'COMPLEX002', DEFAULT_THRESHOLDS.COMPLEX002);
    const linesMax = getRuleThreshold(context.config, 'COMPLEX003', DEFAULT_THRESHOLDS.COMPLEX003);
    const paramsMax = getRuleThreshold(context.config, 'COMPLEX004', DEFAULT_THRESHOLDS.COMPLEX004);
    const nestingMax = getRuleThreshold(context.config, 'COMPLEX005', DEFAULT_THRESHOLDS.COMPLEX005);

    for (const metric of functionMetrics) {
        if (isRuleEnabled(context.config, 'COMPLEX001') && metric.cyclomatic > cyclomaticMax) {
            findings.push(
                buildFinding({
                    ruleId: 'COMPLEX001',
                    category: 'complexity',
                    severity: severityForOverage(metric.cyclomatic, cyclomaticMax),
                    confidence: 'HIGH',
                    file: metric.file,
                    line: metric.line,
                    column: 1,
                    message: 'High cyclomatic complexity function',
                    description: `Function "${metric.name}" has cyclomatic complexity ${metric.cyclomatic} (max ${cyclomaticMax}).`,
                    evidence: `cyclomatic=${metric.cyclomatic}`,
                    suggestion: 'Split the function into smaller units or reduce branching.',
                    fixAvailable: false
                })
            );
        }

        if (isRuleEnabled(context.config, 'COMPLEX002') && metric.cognitive > cognitiveMax) {
            findings.push(
                buildFinding({
                    ruleId: 'COMPLEX002',
                    category: 'complexity',
                    severity: severityForOverage(metric.cognitive, cognitiveMax),
                    confidence: 'HIGH',
                    file: metric.file,
                    line: metric.line,
                    column: 1,
                    message: 'High cognitive complexity function',
                    description: `Function "${metric.name}" has cognitive complexity ${metric.cognitive} (max ${cognitiveMax}).`,
                    evidence: `cognitive=${metric.cognitive}`,
                    suggestion: 'Reduce nesting and simplify control flow.',
                    fixAvailable: false
                })
            );
        }

        if (isRuleEnabled(context.config, 'COMPLEX003') && metric.lines > linesMax) {
            findings.push(
                buildFinding({
                    ruleId: 'COMPLEX003',
                    category: 'complexity',
                    severity: severityForOverage(metric.lines, linesMax),
                    confidence: 'HIGH',
                    file: metric.file,
                    line: metric.line,
                    column: 1,
                    message: 'Function too long',
                    description: `Function "${metric.name}" spans ${metric.lines} lines (max ${linesMax}).`,
                    evidence: `lines=${metric.lines}`,
                    suggestion: 'Extract smaller helper functions.',
                    fixAvailable: false
                })
            );
        }

        if (isRuleEnabled(context.config, 'COMPLEX004') && metric.parameters > paramsMax) {
            findings.push(
                buildFinding({
                    ruleId: 'COMPLEX004',
                    category: 'complexity',
                    severity: severityForOverage(metric.parameters, paramsMax),
                    confidence: 'HIGH',
                    file: metric.file,
                    line: metric.line,
                    column: 1,
                    message: 'Too many parameters',
                    description: `Function "${metric.name}" takes ${metric.parameters} parameters (max ${paramsMax}).`,
                    evidence: `parameters=${metric.parameters}`,
                    suggestion: 'Group related parameters into an options object.',
                    fixAvailable: false
                })
            );
        }

        if (isRuleEnabled(context.config, 'COMPLEX005') && metric.nestingDepth > nestingMax) {
            findings.push(
                buildFinding({
                    ruleId: 'COMPLEX005',
                    category: 'complexity',
                    severity: severityForOverage(metric.nestingDepth, nestingMax),
                    confidence: 'HIGH',
                    file: metric.file,
                    line: metric.line,
                    column: 1,
                    message: 'Excessive nesting depth',
                    description: `Function "${metric.name}" nests ${metric.nestingDepth} levels deep (max ${nestingMax}).`,
                    evidence: `nestingDepth=${metric.nestingDepth}`,
                    suggestion: 'Use early returns or extract nested blocks into their own functions.',
                    fixAvailable: false
                })
            );
        }
    }

    return findings;
}
