import path from 'node:path';
import ts from 'typescript';
import type { RuleContext } from '../context';
import type { Finding } from '../types';
import { buildFinding } from '../finding';
import { isRuleEnabled } from '../config';
import { lineAndColumn } from '../ast/walk';

const IMPLICIT_ANY_CODES = new Set([7005, 7006, 7008, 7010, 7019, 7031, 7034]);

function runAstChecks(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const file of context.files) {
        const sourceFile = context.program.getSourceFile(file);
        if (!sourceFile || !/\.tsx?$/i.test(file)) continue;

        const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');
        const lines = sourceFile.text.split(/\r\n|\r|\n/);

        if (isRuleEnabled(context.config, 'TS002')) {
            for (let i = 0; i < lines.length; i += 1) {
                const trimmed = lines[i].trim();
                if (
                    (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) &&
                    (trimmed.includes('@ts-ignore') || trimmed.includes('@ts-nocheck') || trimmed.includes('@ts-expect-error'))
                ) {
                    findings.push(
                        buildFinding({
                            ruleId: 'TS002',
                            category: 'typescript',
                            severity: 'MEDIUM',
                            confidence: 'CERTAIN',
                            file: relativePath,
                            line: i + 1,
                            column: lines[i].indexOf(trimmed) + 1,
                            message: 'Suppressed type checking',
                            description: 'A directive disables TypeScript checking for the following line or file.',
                            evidence: trimmed,
                            suggestion: 'Fix the underlying type error instead of suppressing it.',
                            fixAvailable: false
                        })
                    );
                }
            }
        }

        const visit = (node: ts.Node): void => {
            if (isRuleEnabled(context.config, 'TS001') && node.kind === ts.SyntaxKind.AnyKeyword) {
                const { line, column } = lineAndColumn(sourceFile, node.getStart());
                findings.push(
                    buildFinding({
                        ruleId: 'TS001',
                        category: 'typescript',
                        severity: 'MEDIUM',
                        confidence: 'CERTAIN',
                        file: relativePath,
                        line,
                        column,
                        message: 'Unsafe any usage',
                        description: 'The code explicitly disables TypeScript safety with any.',
                        evidence: node.parent?.getText().slice(0, 160) ?? 'any',
                        suggestion: 'Replace any with a concrete type or a safer abstraction.',
                        fixAvailable: false
                    })
                );
            }

            if (isRuleEnabled(context.config, 'TS003') && ts.isNonNullExpression(node)) {
                const { line, column } = lineAndColumn(sourceFile, node.getStart());
                findings.push(
                    buildFinding({
                        ruleId: 'TS003',
                        category: 'typescript',
                        severity: 'LOW',
                        confidence: 'CERTAIN',
                        file: relativePath,
                        line,
                        column,
                        message: 'Non-null assertion',
                        description: 'The non-null assertion operator bypasses null/undefined checking.',
                        evidence: node.getText().slice(0, 160),
                        suggestion: 'Narrow the type with a real check instead of asserting non-null.',
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

function runImplicitAnyDiagnostics(context: RuleContext): Finding[] {
    if (!isRuleEnabled(context.config, 'TS001')) return [];

    const findings: Finding[] = [];

    for (const file of context.files) {
        const sourceFile = context.program.getSourceFile(file);
        if (!sourceFile) continue;

        let diagnostics: readonly ts.Diagnostic[] = [];
        try {
            diagnostics = context.program.getSemanticDiagnostics(sourceFile);
        } catch {
            continue;
        }

        const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');

        for (const diagnostic of diagnostics) {
            if (diagnostic.start === undefined || !IMPLICIT_ANY_CODES.has(diagnostic.code)) continue;

            const { line, column } = lineAndColumn(sourceFile, diagnostic.start);
            findings.push(
                buildFinding({
                    ruleId: 'TS001',
                    category: 'typescript',
                    severity: 'MEDIUM',
                    confidence: 'CERTAIN',
                    file: relativePath,
                    line,
                    column,
                    message: 'Implicit any',
                    description: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
                    evidence: `TS${diagnostic.code}`,
                    suggestion: 'Add an explicit type annotation.',
                    fixAvailable: false
                })
            );
        }
    }

    return findings;
}

export function runTypeScriptRules(context: RuleContext): Finding[] {
    return [...runAstChecks(context), ...runImplicitAnyDiagnostics(context)];
}
