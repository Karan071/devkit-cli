import path from 'node:path';
import ts from 'typescript';
import type { RuleContext } from '../context';
import type { Finding } from '../types';
import { buildFinding } from '../finding';
import { isRuleEnabled } from '../config';
import { readFileSafe } from '../discovery';
import { lineAndColumn } from '../ast/walk';

const SECRET_PATTERN = /\b(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)\b\s*[:=]\s*["'`][^"'`]{4,}["'`]/i;
const WEAK_HASH_ALGORITHMS = /^(md5|sha1|des|rc4)$/i;
const EXEC_FUNCTION_NAMES = new Set(['exec', 'execSync']);

function calleeName(expression: ts.Expression): string | null {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    return null;
}

function runSecretScan(context: RuleContext): Finding[] {
    if (!isRuleEnabled(context.config, 'SEC001')) return [];

    const findings: Finding[] = [];

    for (const file of context.files) {
        const text = readFileSafe(file);
        const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');
        const lines = text.split(/\r\n|\r|\n/);

        for (let i = 0; i < lines.length; i += 1) {
            const match = lines[i].match(SECRET_PATTERN);
            if (match) {
                findings.push(
                    buildFinding({
                        ruleId: 'SEC001',
                        category: 'security',
                        severity: 'HIGH',
                        confidence: 'HIGH',
                        file: relativePath,
                        line: i + 1,
                        column: (match.index ?? 0) + 1,
                        message: 'Potential secret in source',
                        description: 'A hardcoded credential or token-like value appears in code.',
                        evidence: lines[i].trim(),
                        suggestion: 'Move sensitive values to environment variables or secure secret storage.',
                        fixAvailable: false
                    })
                );
            }

            if (/NODE_TLS_REJECT_UNAUTHORIZED['"]?\s*[:=]\s*['"]?0/.test(lines[i])) {
                findings.push(
                    buildFinding({
                        ruleId: 'SEC007',
                        category: 'security',
                        severity: 'HIGH',
                        confidence: 'HIGH',
                        file: relativePath,
                        line: i + 1,
                        column: 1,
                        message: 'TLS certificate verification disabled',
                        description: 'NODE_TLS_REJECT_UNAUTHORIZED is set to 0, disabling TLS verification process-wide.',
                        evidence: lines[i].trim(),
                        suggestion: 'Remove the override and fix the underlying certificate problem.',
                        fixAvailable: false
                    })
                );
            }
        }
    }

    return findings;
}

function runAstSecurityChecks(context: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const file of context.files) {
        const sourceFile = context.program.getSourceFile(file);
        if (!sourceFile) continue;

        const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');

        const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node)) {
                const name = calleeName(node.expression);

                if (isRuleEnabled(context.config, 'SEC002') && name === 'eval') {
                    const { line, column } = lineAndColumn(sourceFile, node.getStart());
                    findings.push(
                        buildFinding({
                            ruleId: 'SEC002',
                            category: 'security',
                            severity: 'HIGH',
                            confidence: 'CERTAIN',
                            file: relativePath,
                            line,
                            column,
                            message: 'Use of eval',
                            description: 'eval executes arbitrary strings as code and is a common injection vector.',
                            evidence: node.getText().slice(0, 160),
                            suggestion: 'Avoid eval; use a safer alternative such as JSON.parse or a dedicated parser.',
                            fixAvailable: false
                        })
                    );
                }

                if (isRuleEnabled(context.config, 'SEC003') && name && EXEC_FUNCTION_NAMES.has(name) && node.arguments.length > 0) {
                    const firstArg = node.arguments[0];
                    const isDynamic = ts.isTemplateExpression(firstArg) || ts.isBinaryExpression(firstArg);

                    if (isDynamic) {
                        const { line, column } = lineAndColumn(sourceFile, node.getStart());
                        findings.push(
                            buildFinding({
                                ruleId: 'SEC003',
                                category: 'security',
                                severity: 'HIGH',
                                confidence: 'MEDIUM',
                                file: relativePath,
                                line,
                                column,
                                message: 'Dangerous command execution',
                                description: `${name}() is invoked with a dynamically built command string, risking command injection.`,
                                evidence: node.getText().slice(0, 160),
                                suggestion: 'Use execFile/spawn with an argument array instead of a concatenated shell string.',
                                fixAvailable: false
                            })
                        );
                    }
                }

                if (isRuleEnabled(context.config, 'SEC005') && name === 'createHash' && node.arguments.length > 0) {
                    const arg = node.arguments[0];
                    if (ts.isStringLiteral(arg) && WEAK_HASH_ALGORITHMS.test(arg.text)) {
                        const { line, column } = lineAndColumn(sourceFile, node.getStart());
                        findings.push(
                            buildFinding({
                                ruleId: 'SEC005',
                                category: 'security',
                                severity: 'MEDIUM',
                                confidence: 'HIGH',
                                file: relativePath,
                                line,
                                column,
                                message: 'Weak cryptographic hash',
                                description: `"${arg.text}" is not a cryptographically strong hash algorithm.`,
                                evidence: node.getText().slice(0, 160),
                                suggestion: 'Use a modern algorithm such as sha256 or stronger.',
                                fixAvailable: false
                            })
                        );
                    }
                }
            }

            if (isRuleEnabled(context.config, 'SEC004')) {
                if (
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                    ts.isPropertyAccessExpression(node.left) &&
                    (node.left.name.text === 'innerHTML' || node.left.name.text === 'outerHTML')
                ) {
                    const { line, column } = lineAndColumn(sourceFile, node.getStart());
                    findings.push(
                        buildFinding({
                            ruleId: 'SEC004',
                            category: 'security',
                            severity: 'MEDIUM',
                            confidence: 'MEDIUM',
                            file: relativePath,
                            line,
                            column,
                            message: 'Unsafe HTML assignment',
                            description: `Assigning to ${node.left.name.text} can introduce cross-site scripting if the value is not sanitized.`,
                            evidence: node.getText().slice(0, 160),
                            suggestion: 'Sanitize the value or use safe DOM APIs such as textContent.',
                            fixAvailable: false
                        })
                    );
                }

                if (ts.isJsxAttribute(node) && node.name.getText() === 'dangerouslySetInnerHTML') {
                    const { line, column } = lineAndColumn(sourceFile, node.getStart());
                    findings.push(
                        buildFinding({
                            ruleId: 'SEC004',
                            category: 'security',
                            severity: 'MEDIUM',
                            confidence: 'MEDIUM',
                            file: relativePath,
                            line,
                            column,
                            message: 'Unsafe HTML assignment',
                            description: 'dangerouslySetInnerHTML can introduce cross-site scripting if the value is not sanitized.',
                            evidence: node.getText().slice(0, 160),
                            suggestion: 'Sanitize the HTML before rendering, or avoid raw HTML injection.',
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

export function runSecurityRules(context: RuleContext): Finding[] {
    return [...runSecretScan(context), ...runAstSecurityChecks(context)];
}
