import path from 'node:path';
import ts from 'typescript';
import type { RuleContext } from '../context';
import type { Finding } from '../types';
import { buildFinding } from '../finding';
import { isRuleEnabled } from '../config';
import { isTestFile, readFileSafe } from '../discovery';
import { lineAndColumn } from '../ast/walk';
import { SECRET_PATTERNS, looksHighEntropy } from './secretPatterns';

const SECRET_PATTERN = /\b(API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)\b\s*[:=]\s*["'`]([^"'`]{4,})["'`]/i;
const WEAK_HASH_ALGORITHMS = /^(md5|sha1|des|rc4)$/i;
const EXEC_FUNCTION_NAMES = new Set(['exec', 'execSync']);
const SHELL_FUNCTION_NAMES = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync']);
const FILE_FUNCTION_NAMES = new Set(['readFile', 'readFileSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createReadStream', 'createWriteStream', 'unlink', 'unlinkSync', 'open', 'openSync', 'stat', 'statSync', 'access', 'accessSync']);

function calleeName(expression: ts.Expression): string | null {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    return null;
}

function isDynamicString(expression: ts.Expression): boolean {
    return ts.isTemplateExpression(expression) || ts.isBinaryExpression(expression);
}

function nearestFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
    return ts.findAncestor(node, (ancestor): ancestor is ts.FunctionLikeDeclaration =>
        ts.isFunctionDeclaration(ancestor) || ts.isFunctionExpression(ancestor) || ts.isArrowFunction(ancestor) || ts.isMethodDeclaration(ancestor) || ts.isConstructorDeclaration(ancestor)
    );
}

function hasShellEnabled(node: ts.CallExpression): boolean {
    return node.arguments.some((argument) => ts.isObjectLiteralExpression(argument) && argument.properties.some((property) =>
        ts.isPropertyAssignment(property) && property.name.getText() === 'shell' && property.initializer.kind === ts.SyntaxKind.TrueKeyword
    ));
}

function isDynamicCommandArgument(node: ts.CallExpression): boolean {
    const first = node.arguments[0];
    if (!first) return false;
    if (isDynamicString(first)) return true;
    if (!ts.isIdentifier(first)) return false;
    const enclosingFunction = nearestFunction(node);
    let nearestDeclaration: ts.VariableDeclaration | undefined;
    const sourceFile = node.getSourceFile();
    const visit = (current: ts.Node): void => {
        if (current !== sourceFile && current !== enclosingFunction &&
            (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current) || ts.isMethodDeclaration(current))) return;
        if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.name.text === first.text &&
            current.initializer && current.getStart() < node.getStart() && nearestFunction(current) === enclosingFunction &&
            (!nearestDeclaration || current.getStart() > nearestDeclaration.getStart())) nearestDeclaration = current;
        ts.forEachChild(current, visit);
    };
    visit(enclosingFunction ?? sourceFile);
    return !!nearestDeclaration?.initializer && isDynamicString(nearestDeclaration.initializer);
}

function containsUntrustedInput(expression: ts.Expression): boolean {
    return /\.(?:params|query|body)\b/.test(expression.getText());
}

function hasPathSanitizer(node: ts.Node): boolean {
    return /(?:normalize|sanitize|safePath|allowedPaths|allowlist)\s*\(/i.test(node.getText());
}

function runSecretScan(context: RuleContext): Finding[] {
    if (!isRuleEnabled(context.config, 'SEC001')) return [];

    const findings: Finding[] = [];

    for (const file of context.files) {
        const text = readFileSafe(file);
        const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');
        const lines = text.split(/\r\n|\r|\n/);
        const isTestFixture = isTestFile(relativePath) || /(?:^|\/)(?:fixtures?|__mocks__)(?:\/|$)/i.test(relativePath);

        for (let i = 0; i < lines.length; i += 1) {
            const providerPattern = SECRET_PATTERNS.find((pattern) => pattern.regex.test(lines[i]));
            const fallbackMatch = !providerPattern && !isTestFixture ? lines[i].match(SECRET_PATTERN) : null;
            if (providerPattern || (fallbackMatch && looksHighEntropy(fallbackMatch[2]))) {
                findings.push(
                    buildFinding({
                        ruleId: 'SEC001',
                        category: 'security',
                        severity: 'HIGH',
                        confidence: providerPattern ? 'HIGH' : 'MEDIUM',
                        file: relativePath,
                        line: i + 1,
                        column: providerPattern ? lines[i].search(providerPattern.regex) + 1 : lines[i].indexOf(fallbackMatch![0]) + 1,
                        message: providerPattern ? `Potential ${providerPattern.label}` : 'Potential secret in source',
                        description: providerPattern
                            ? `A value matches the known format for a ${providerPattern.label}.`
                            : 'A high-entropy value is assigned to a credential-like variable name.',
                        evidence: providerPattern ? `${providerPattern.label} pattern matched` : `${fallbackMatch![1]}=[redacted]`,
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
        const imports = context.moduleGraph.importsByFile.get(file) ?? [];
        const importedPackages = new Set(imports.filter((item) => !item.isRelative).map((item) => item.specifier.startsWith('@') ? item.specifier.split('/').slice(0, 2).join('/') : item.specifier.split('/')[0]));

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
                    const isDynamic = isDynamicCommandArgument(node);

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

                if (isRuleEnabled(context.config, 'SEC003') && name && SHELL_FUNCTION_NAMES.has(name) && hasShellEnabled(node)) {
                    const { line, column } = lineAndColumn(sourceFile, node.getStart());
                    findings.push(buildFinding({
                        ruleId: 'SEC003', category: 'security', severity: 'HIGH', confidence: 'HIGH', file: relativePath, line, column,
                        message: 'Shell execution enabled',
                        description: `${name}() enables shell execution with shell: true, so untrusted arguments can become shell commands.`,
                        evidence: node.getText().slice(0, 160),
                        suggestion: 'Remove shell: true or ensure every argument is fixed and trusted.', fixAvailable: false
                    }));
                }

                if (isRuleEnabled(context.config, 'SEC004') && name === 'insertAdjacentHTML') {
                    const { line, column } = lineAndColumn(sourceFile, node.getStart());
                    findings.push(buildFinding({
                        ruleId: 'SEC004', category: 'security', severity: 'MEDIUM', confidence: 'HIGH', file: relativePath, line, column,
                        message: 'Unsafe HTML insertion',
                        description: 'insertAdjacentHTML parses a string as HTML and can introduce cross-site scripting when the value is untrusted.',
                        evidence: node.getText().slice(0, 160),
                        suggestion: 'Sanitize the HTML or use safe DOM APIs such as textContent.', fixAvailable: false
                    }));
                }

                if (isRuleEnabled(context.config, 'SEC008') && name && ['query', 'execute'].includes(name) && node.arguments[0] && isDynamicString(node.arguments[0])) {
                    const queryText = node.arguments[0].getText();
                    if (/\b(select|insert|update|delete|replace|with)\b/i.test(queryText)) {
                        const { line, column } = lineAndColumn(sourceFile, node.getStart());
                        findings.push(buildFinding({
                            ruleId: 'SEC008', category: 'security', severity: 'HIGH', confidence: 'MEDIUM', file: relativePath, line, column,
                            message: 'Potential SQL injection',
                            description: 'A query string is dynamically constructed and may include untrusted input.',
                            evidence: node.getText().slice(0, 160),
                            suggestion: 'Use parameterized queries and keep user input out of SQL syntax.', fixAvailable: false
                        }));
                    }
                }

                if (isRuleEnabled(context.config, 'SEC009') && name) {
                    const pathJoin = name === 'join' && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText() === 'path';
                    const filesystemCall = FILE_FUNCTION_NAMES.has(name);
                    const relevantArgs = pathJoin ? node.arguments : node.arguments.slice(0, 1);
                    if ((pathJoin || filesystemCall) && !hasPathSanitizer(node) && relevantArgs.some(containsUntrustedInput)) {
                        const { line, column } = lineAndColumn(sourceFile, node.getStart());
                        findings.push(buildFinding({
                            ruleId: 'SEC009', category: 'security', severity: 'HIGH', confidence: 'LOW', file: relativePath, line, column,
                            message: 'Potential path traversal',
                            description: 'A filesystem path is built from request parameters without an obvious normalization or allowlist step.',
                            evidence: node.getText().slice(0, 160),
                            suggestion: 'Resolve the path against an allowed root and verify the normalized result stays inside it.', fixAvailable: false
                        }));
                    }
                }

                if (isRuleEnabled(context.config, 'SEC010') && name) {
                    const unsafeDeserializer = (name === 'unserialize' && (importedPackages.has('node-serialize') || importedPackages.has('serialize-javascript'))) ||
                        name === 'runInNewContext' || (name === 'load' && importedPackages.has('js-yaml'));
                    if (unsafeDeserializer) {
                        const { line, column } = lineAndColumn(sourceFile, node.getStart());
                        findings.push(buildFinding({
                            ruleId: 'SEC010', category: 'security', severity: 'HIGH', confidence: 'MEDIUM', file: relativePath, line, column,
                            message: 'Unsafe deserialization or dynamic execution',
                            description: `${name}() can execute or construct unsafe values from untrusted input.`,
                            evidence: node.getText().slice(0, 160),
                            suggestion: 'Use a safe data format and avoid deserializing untrusted objects or executing input.', fixAvailable: false
                        }));
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

function scanTemplateFilesForUnsafeBindings(context: RuleContext): Finding[] {
    if (!isRuleEnabled(context.config, 'SEC004')) return [];
    const findings: Finding[] = [];
    for (const file of context.allFiles) {
        if (!/\.(?:vue|html)$/i.test(file)) continue;
        const text = readFileSafe(file);
        const lines = text.split(/\r\n|\r|\n/);
        const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');
        for (let index = 0; index < lines.length; index += 1) {
            const match = /(?:\bv-html\s*=|\[innerHTML\]\s*=)/i.exec(lines[index]);
            if (!match) continue;
            findings.push(buildFinding({
                ruleId: 'SEC004', category: 'security', severity: 'MEDIUM', confidence: 'LOW', file: relativePath,
                line: index + 1, column: match.index + 1, message: 'Unsafe template HTML binding',
                description: 'A template uses a raw HTML binding; the text scan cannot verify whether the value is sanitized.',
                evidence: match[0], suggestion: 'Sanitize the bound value or render it as text.', fixAvailable: false
            }));
        }
    }
    return findings;
}

export function runSecurityRules(context: RuleContext): Finding[] {
    return [...runSecretScan(context), ...runAstSecurityChecks(context), ...scanTemplateFilesForUnsafeBindings(context)];
}
