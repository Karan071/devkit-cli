import path from 'node:path';
import ts from 'typescript';
import type { RuleContext } from '../context';
import type { Finding } from '../types';
import { buildFinding } from '../finding';
import { isRuleEnabled } from '../config';
import { readFileSafe } from '../discovery';
import { lineAndColumn } from '../ast/walk';
import { runSecretScan } from './secrets';
import { runTaintRules, type TaintResult } from './taint';
import { EXEC_FUNCTION_NAMES, FILE_FUNCTION_NAMES, SHELL_FUNCTION_NAMES, SQL_FUNCTION_NAMES, calleeName, importedCalleeName, mayBeShellExecution } from './securityHelpers';

const WEAK_HASH_ALGORITHMS = /^(md5|sha1|des|rc4)$/i;
type HtmlSource = 'static' | 'serialized' | 'dynamic';

/** What flows into an HTML sink: a literal can't be attacker-controlled, serialized JSON rarely can, anything else might be. */
function classifyHtmlSource(expression: ts.Expression | undefined): HtmlSource {
    if (!expression) return 'dynamic';
    let value = expression;
    while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isNonNullExpression(value)) value = value.expression;
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return 'static';
    if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) &&
        ts.isIdentifier(value.expression.expression) && value.expression.expression.text === 'JSON' && value.expression.name.text === 'stringify') return 'serialized';
    return 'dynamic';
}

/** The expression assigned to `__html` in `dangerouslySetInnerHTML={{ __html: ... }}`. */
function jsxHtmlValue(attribute: ts.JsxAttribute): ts.Expression | undefined {
    const initializer = attribute.initializer;
    if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression || !ts.isObjectLiteralExpression(initializer.expression)) return undefined;
    for (const property of initializer.expression.properties) {
        if (ts.isPropertyAssignment(property) && property.name.getText() === '__html') return property.initializer;
    }
    return undefined;
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

/**
 * The dynamically built string passed as the call's first argument: the argument itself when it is a
 * template or concatenation, or the initializer of the nearest preceding `const q = ...` it names.
 */
function dynamicFirstArgument(node: ts.CallExpression): ts.Expression | undefined {
    const first = node.arguments[0];
    if (!first) return undefined;
    if (isDynamicString(first)) return first;
    if (!ts.isIdentifier(first)) return undefined;
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
    return nearestDeclaration?.initializer && isDynamicString(nearestDeclaration.initializer) ? nearestDeclaration.initializer : undefined;
}

function isDynamicCommandArgument(node: ts.CallExpression): boolean {
    return dynamicFirstArgument(node) !== undefined;
}

/** `{ rejectUnauthorized: false }`-style options and a `checkServerIdentity` that accepts every certificate. */
const TLS_OFF_OPTIONS: Record<string, ts.SyntaxKind> = {
    rejectUnauthorized: ts.SyntaxKind.FalseKeyword,
    strictSSL: ts.SyntaxKind.FalseKeyword,
    insecure: ts.SyntaxKind.TrueKeyword
};

function isNoopFunction(expression: ts.Expression): boolean {
    if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return false;
    const body = expression.body;
    if (!ts.isBlock(body)) return ts.isIdentifier(body) ? body.text === 'undefined' : ts.isVoidExpression(body) || body.kind === ts.SyntaxKind.NullKeyword;
    return body.statements.every((statement) => ts.isReturnStatement(statement) && (!statement.expression || statement.expression.getText() === 'undefined'));
}

/** The option that switches certificate verification off, if this node is one. */
function tlsDisablingOption(node: ts.Node): string | undefined {
    let name: string | undefined;
    let value: ts.Expression | undefined;
    if (ts.isPropertyAssignment(node)) {
        name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
        value = node.initializer;
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
        name = node.left.name.text;
        value = node.right;
    }
    if (!name || !value) return undefined;
    if (name in TLS_OFF_OPTIONS) return value.kind === TLS_OFF_OPTIONS[name] ? name : undefined;
    return name === 'checkServerIdentity' && isNoopFunction(value) ? name : undefined;
}

function containsUntrustedInput(expression: ts.Expression): boolean {
    return /\.(?:params|query|body)\b/.test(expression.getText());
}

function hasPathSanitizer(node: ts.Node): boolean {
    return /(?:normalize|sanitize|safePath|allowedPaths|allowlist)\s*\(/i.test(node.getText());
}

function runAstSecurityChecks(context: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const checker = context.program.getTypeChecker();

    for (const file of context.files) {
        const sourceFile = context.program.getSourceFile(file);
        if (!sourceFile) continue;

        const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');
        const imports = context.moduleGraph.importsByFile.get(file) ?? [];
        const importedModules = new Set(imports.map((item) => item.specifier));
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

                const execName = name && EXEC_FUNCTION_NAMES.has(name) ? name : importedCalleeName(checker, node.expression);
                if (isRuleEnabled(context.config, 'SEC003') && execName && EXEC_FUNCTION_NAMES.has(execName) && node.arguments.length > 0 && mayBeShellExecution(checker, node, importedModules)) {
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
                                description: `${execName}() is invoked with a dynamically built command string, risking command injection.`,
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

                if (isRuleEnabled(context.config, 'SEC008') && name && SQL_FUNCTION_NAMES.has(name)) {
                    // Either the query is built inline, or it was built into a variable that is passed in.
                    const queryExpression = dynamicFirstArgument(node);
                    if (queryExpression && /\b(select|insert|update|delete|replace|with)\b/i.test(queryExpression.getText())) {
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

            const tlsOption = isRuleEnabled(context.config, 'SEC007') ? tlsDisablingOption(node) : undefined;
            if (tlsOption) {
                const { line, column } = lineAndColumn(sourceFile, node.getStart());
                findings.push(buildFinding({
                    ruleId: 'SEC007', category: 'security', severity: 'HIGH', confidence: tlsOption === 'insecure' ? 'MEDIUM' : 'HIGH', file: relativePath, line, column,
                    message: 'TLS certificate verification disabled',
                    description: `${tlsOption} turns off certificate verification, so a man-in-the-middle can impersonate the server.`,
                    evidence: node.getText().slice(0, 160),
                    suggestion: 'Remove the option and fix the underlying certificate problem (trust the CA instead of skipping verification).', fixAvailable: false
                }));
            }

            if (isRuleEnabled(context.config, 'SEC004')) {
                if (
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                    ts.isPropertyAccessExpression(node.left) &&
                    (node.left.name.text === 'innerHTML' || node.left.name.text === 'outerHTML') &&
                    classifyHtmlSource(node.right) !== 'static'
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

                const jsxSource = ts.isJsxAttribute(node) && node.name.getText() === 'dangerouslySetInnerHTML' ? classifyHtmlSource(jsxHtmlValue(node)) : null;
                if (ts.isJsxAttribute(node) && jsxSource && jsxSource !== 'static') {
                    const { line, column } = lineAndColumn(sourceFile, node.getStart());
                    findings.push(
                        buildFinding({
                            ruleId: 'SEC004',
                            category: 'security',
                            severity: 'MEDIUM',
                            confidence: jsxSource === 'serialized' ? 'LOW' : 'MEDIUM',
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
    for (const file of context.textFiles) {
        if (!/\.(?:vue|html|svelte)$/i.test(file)) continue;
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

/**
 * Merges taint findings into the pattern-based ones. Where both flag the same call, the pattern finding stays and
 * takes the flow's confidence if that is higher, with the flow added: data that provably comes from a request is the strongest evidence
 * the heuristic can get. A flow the patterns missed becomes a finding of its own.
 */
const CONFIDENCE_RANK: Record<Finding['confidence'], number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CERTAIN: 3 };

function mergeTaintFindings(patternFindings: Finding[], taint: TaintResult): Finding[] {
    // A call whose data was explicitly cleaned (parseInt, path.basename, an escaper) is not an injection, whatever its shape suggests.
    const merged = patternFindings.filter((finding) => !taint.cleared.some((cleared) => cleared.ruleId === finding.ruleId && cleared.file === finding.file && cleared.line === finding.line));
    for (const finding of taint.findings) {
        const existing = merged.find((other) => other.ruleId === finding.ruleId && other.file === finding.file && other.line === finding.line);
        if (existing) {
            // The flow is evidence in its own right: keep whichever of the two confidences is higher.
            if (CONFIDENCE_RANK[finding.confidence] > CONFIDENCE_RANK[existing.confidence]) existing.confidence = finding.confidence;
            if (!existing.description.includes('flows to')) existing.description = `${existing.description} ${finding.description.slice(finding.description.indexOf('Data from') >= 0 ? finding.description.indexOf('Data from') : 0)}`;
            continue;
        }
        merged.push(finding);
    }
    return merged;
}

export function runSecurityRules(context: RuleContext): Finding[] {
    const patterns = [...runSecretScan(context), ...runAstSecurityChecks(context), ...scanTemplateFilesForUnsafeBindings(context)];
    return mergeTaintFindings(patterns, runTaintRules(context));
}
