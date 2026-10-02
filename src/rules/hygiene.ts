import path from 'node:path';
import ts from 'typescript';
import type { RuleContext } from '../context';
import type { Finding } from '../types';
import { buildFinding } from '../finding';
import { isRuleEnabled } from '../config';
import { readFileSafe } from '../discovery';
import { collectCommentRanges } from '../ast/comments';
import { lineAndColumn } from '../ast/walk';

const BACKUP_FILE_PATTERN = /(\.bak|\.orig|\.tmp|~)$/i;
const ENV_FILE_PATTERN = /^\.env(\..+)?$/i;
const ENV_SAFE_SUFFIXES = /\.(example|sample|template|dist)$/i;

export function runHygieneRules(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const file of context.files) {
        const text = readFileSafe(file);
        const sourceFile = context.program.getSourceFile(file);
        if (!sourceFile) continue;
        const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');
        const visit = (node: ts.Node): void => {
            if (isRuleEnabled(context.config, 'HYGIENE001') && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
                ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'console' &&
                ['log', 'debug', 'warn', 'error'].includes(node.expression.name.text)) {
                const { line, column } = lineAndColumn(sourceFile, node.getStart());
                findings.push(buildFinding({
                    ruleId: 'HYGIENE001', category: 'hygiene', severity: 'LOW', confidence: 'CERTAIN', file: relativePath, line, column,
                    message: 'Debug statement found', description: 'Console output remains in source code.', evidence: node.getText().slice(0, 160),
                    suggestion: 'Remove or gate debug logging before production deployment.', fixAvailable: true
                }));
            }
            if (isRuleEnabled(context.config, 'HYGIENE001') && ts.isDebuggerStatement(node)) {
                const { line, column } = lineAndColumn(sourceFile, node.getStart());
                findings.push(buildFinding({
                    ruleId: 'HYGIENE001', category: 'hygiene', severity: 'LOW', confidence: 'CERTAIN', file: relativePath, line, column,
                    message: 'Debugger statement found', description: 'Debugger statements are left in code and can leak runtime state.', evidence: node.getText(),
                    suggestion: 'Remove debugger statements before committing code.', fixAvailable: true
                }));
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);

        if (isRuleEnabled(context.config, 'HYGIENE002')) {
            for (const range of collectCommentRanges(sourceFile)) {
                const comment = text.slice(range.pos, range.end);
                const markers = /\b(TODO|FIXME|HACK|XXX)\b/g;
                for (const match of comment.matchAll(markers)) {
                    const position = range.pos + (match.index ?? 0);
                    const { line, column } = lineAndColumn(sourceFile, position);
                    findings.push(buildFinding({
                        ruleId: 'HYGIENE002', category: 'hygiene', severity: 'LOW', confidence: 'MEDIUM', file: relativePath, line, column,
                        message: 'Temporary marker found', description: 'A marker suggests unresolved work or temporary code remains in the repository.',
                        evidence: match[0], suggestion: 'Track the issue properly or remove the marker before merge.', fixAvailable: true
                    }));
                }
            }
        }
    }

    if (isRuleEnabled(context.config, 'HYGIENE003') || isRuleEnabled(context.config, 'HYGIENE004')) {
        for (const file of context.allFiles) {
            const basename = path.basename(file);
            const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');

            if (isRuleEnabled(context.config, 'HYGIENE003') && BACKUP_FILE_PATTERN.test(basename)) {
                findings.push(
                    buildFinding({
                        ruleId: 'HYGIENE003',
                        category: 'hygiene',
                        severity: 'LOW',
                        confidence: 'HIGH',
                        file: relativePath,
                        line: 1,
                        column: 1,
                        message: 'Backup or temporary file committed',
                        description: 'A backup/temporary file was found in the repository.',
                        evidence: relativePath,
                        suggestion: 'Delete the file and add its pattern to .gitignore.',
                        fixAvailable: false
                    })
                );
            }

            if (isRuleEnabled(context.config, 'HYGIENE004') && ENV_FILE_PATTERN.test(basename) && !ENV_SAFE_SUFFIXES.test(basename)) {
                findings.push(
                    buildFinding({
                        ruleId: 'HYGIENE004',
                        category: 'hygiene',
                        severity: 'HIGH',
                        confidence: 'MEDIUM',
                        file: relativePath,
                        line: 1,
                        column: 1,
                        message: 'Committed .env file',
                        description: 'An environment file is present in the repository and may contain secrets.',
                        evidence: relativePath,
                        suggestion: 'Remove the file from version control and add it to .gitignore.',
                        fixAvailable: false
                    })
                );
            }
        }
    }

    return findings;
}
