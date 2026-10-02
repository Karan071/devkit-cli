import path from 'node:path';
import type { RuleContext } from '../context';
import type { Finding } from '../types';
import { buildFinding } from '../finding';
import { isRuleEnabled } from '../config';
import { readFileSafe } from '../discovery';

const BACKUP_FILE_PATTERN = /(\.bak|\.orig|\.tmp|~)$/i;
const ENV_FILE_PATTERN = /^\.env(\..+)?$/i;
const ENV_SAFE_SUFFIXES = /\.(example|sample|template|dist)$/i;

export function runHygieneRules(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const file of context.files) {
        const text = readFileSafe(file);
        const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');
        const lines = text.split(/\r\n|\r|\n/);

        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];

            if (isRuleEnabled(context.config, 'HYGIENE001') && /console\.(log|debug|warn|error)\s*\(/.test(line)) {
                findings.push(
                    buildFinding({
                        ruleId: 'HYGIENE001',
                        category: 'hygiene',
                        severity: 'LOW',
                        confidence: 'CERTAIN',
                        file: relativePath,
                        line: i + 1,
                        column: line.search(/console\./) + 1,
                        message: 'Debug statement found',
                        description: 'Console output remains in source code.',
                        evidence: line.trim(),
                        suggestion: 'Remove or gate debug logging before production deployment.',
                        fixAvailable: true
                    })
                );
            }

            if (isRuleEnabled(context.config, 'HYGIENE001') && /\bdebugger\b/.test(line)) {
                findings.push(
                    buildFinding({
                        ruleId: 'HYGIENE001',
                        category: 'hygiene',
                        severity: 'LOW',
                        confidence: 'CERTAIN',
                        file: relativePath,
                        line: i + 1,
                        column: line.search(/debugger/) + 1,
                        message: 'Debugger statement found',
                        description: 'Debugger statements are left in code and can leak runtime state.',
                        evidence: line.trim(),
                        suggestion: 'Remove debugger statements before committing code.',
                        fixAvailable: true
                    })
                );
            }

            if (isRuleEnabled(context.config, 'HYGIENE002') && /\b(TODO|FIXME|HACK|XXX)\b/.test(line)) {
                findings.push(
                    buildFinding({
                        ruleId: 'HYGIENE002',
                        category: 'hygiene',
                        severity: 'LOW',
                        confidence: 'MEDIUM',
                        file: relativePath,
                        line: i + 1,
                        column: line.search(/\b(TODO|FIXME|HACK|XXX)\b/) + 1,
                        message: 'Temporary marker found',
                        description: 'A marker suggests unresolved work or temporary code remains in the repository.',
                        evidence: line.trim(),
                        suggestion: 'Track the issue properly or remove the marker before merge.',
                        fixAvailable: true
                    })
                );
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
