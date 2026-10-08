import path from 'node:path';
import ts from 'typescript';
import type { RuleContext } from '../context';
import type { Confidence, Finding, Severity } from '../types';
import { buildFinding } from '../finding';
import { isRuleEnabled } from '../config';
import { isTestFile, readFileSafe } from '../discovery';
import { classifyFile } from '../fileKind';
import { lineAndColumn } from '../ast/walk';
import { SECRET_PATTERNS, credentialKind, isPublicOrDemoJwt, looksLikeNonSecretValue, looksLikeSecretValue, type SecretPattern } from './secretPatterns';

const PLACEHOLDER_VALUE = /example|sample|dummy|placeholder|changeme|your[_-]|xxxx|<[^>]*>|\$\{|\{\{|process\.env|^\*+$/i;
const DOCUMENTATION_FILE = /\.(?:md|mdx|markdown|rst|txt|adoc)$/i;
// `.env.example`, `.env.local.sample`, `config.template.toml`: files whose whole purpose is to hold placeholders.
const EXAMPLE_CONFIG_FILE = /(?:^|[./_-])(?:example|sample|template|dist)(?:[./_-]|$)/i;
const JSON_FILE = /\.(?:json|jsonc|json5)$/i;
// Keys whose values are package names, versions, URLs or people rather than credentials.
const METADATA_KEYS = new Set([
    'dependencies', 'devdependencies', 'peerdependencies', 'optionaldependencies', 'bundleddependencies', 'bundledependencies',
    'peerdependenciesmeta', 'resolutions', 'overrides', 'pnpm', 'workspaces', 'author', 'authors', 'contributors', 'maintainers', 'funding', 'repository', 'bugs'
]);
// Unquoted `key: value` / `KEY=value` assignments as found in .env, YAML, TOML, INI, properties and Dockerfiles.
const CONFIG_ASSIGNMENT = /^\s*(?:-\s+)?(?:(?:ENV|ARG|export|set)\s+)?["']?([A-Za-z0-9_.-]+)["']?\s*[:=]\s*["']?([^\s"',;}]+)/;
const CONFIG_COMMENT = /^\s*(?:#|\/\/|;|\/\*|\*)/;
const SOURCE_MIN_LENGTH = 20;
const CONFIG_MIN_LENGTH = 16;

interface FileContext {
    relativePath: string;
    /** Sample data in tests, fixtures, benchmarks and examples (a JWT to parse, a PEM for a TLS test) is not a leaked credential. */
    isTestFixture: boolean;
    isDocumentation: boolean;
    text: string;
}

function secretFinding(file: string, line: number, column: number, severity: Severity, confidence: Confidence, message: string, description: string, evidence: string): Finding {
    return buildFinding({
        ruleId: 'SEC001', category: 'security', severity, confidence, file, line, column, message, description, evidence,
        suggestion: 'Move sensitive values to environment variables or secure secret storage.', fixAvailable: false
    });
}

/** Whether a Google API key is a Firebase web key, which is meant to be embedded in client code. */
function isFirebaseContext(line: string, fileText: string): boolean {
    return /firebase/i.test(line) || /firebase|authDomain|messagingSenderId|measurementId/i.test(fileText);
}

/** A token with a known provider format. The name it is assigned to does not matter, and neither does a comment: a leaked key in a comment is still leaked. */
function scanProviderTokens(file: FileContext, lines: string[]): { findings: Finding[]; reportedLines: Set<number> } {
    const findings: Finding[] = [];
    const reportedLines = new Set<number>();

    lines.forEach((line, index) => {
        let pattern: SecretPattern | undefined;
        let matched = '';
        let weak = false;
        for (const candidate of SECRET_PATTERNS) {
            const match = line.match(candidate.regex);
            if (!match) continue;
            const verdict = candidate.assess?.(match[0]);
            if (verdict === 'reject') continue;
            pattern = candidate;
            matched = match[0];
            weak = verdict === 'weak';
            break;
        }
        if (!pattern) return;

        const hasExampleMarker = /EXAMPLE/.test(line);
        const publicByDesign = !!pattern.publicByDesign ||
            (pattern.id === 'jwt' && isPublicOrDemoJwt(matched)) ||
            (pattern.id === 'google-api-key' && isFirebaseContext(line, file.text));
        // Sample data is only a leak when it looks like a live credential: an AKIA key, a live Stripe key or a valid GitHub token.
        const livelike = !!pattern.productionLike?.(matched) && !weak && !hasExampleMarker && !file.isDocumentation;
        const discounted = publicByDesign || hasExampleMarker || ((file.isTestFixture || file.isDocumentation) && !livelike);

        let severity: Severity = 'HIGH';
        let confidence: Confidence = pattern.id === 'database-url' ? 'MEDIUM' : 'HIGH';
        if (discounted) {
            // Kept visible, but informational: it must not cost points.
            severity = 'INFO';
            confidence = 'LOW';
        } else if (weak) {
            confidence = 'LOW';
        }

        reportedLines.add(index);
        findings.push(secretFinding(
            file.relativePath, index + 1, line.search(pattern.regex) + 1, severity, confidence,
            `Potential ${pattern.label}`,
            publicByDesign
                ? `A value matches the format for a ${pattern.label}, which is public by design.`
                : weak
                    ? `A value looks like a ${pattern.label} but fails the provider's own format check, so it is probably not a live credential.`
                    : `A value matches the known format for a ${pattern.label}.`,
            `${pattern.label} pattern matched`
        ));
    });

    return { findings, reportedLines };
}

function credentialValueCheck(name: string, value: string, minLength: number): boolean {
    const kind = credentialKind(name);
    if (!kind) return false;
    if (PLACEHOLDER_VALUE.test(value) || looksLikeNonSecretValue(value)) return false;
    return looksLikeSecretValue(value, kind, minLength);
}

function propertyKey(name: ts.PropertyName | ts.Expression): string | undefined {
    return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

/** String literals assigned to credential-like names in TS/JS, found in the syntax tree so comments and prose never match. */
function scanSourceAssignments(file: FileContext, sourceFile: ts.SourceFile, skipLines: Set<number>): Finding[] {
    const findings: Finding[] = [];

    const visit = (node: ts.Node): void => {
        let name: string | undefined;
        let value: ts.Expression | undefined;
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            name = node.name.text;
            value = node.initializer;
        } else if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) {
            name = propertyKey(node.name);
            value = node.initializer;
        } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            name = ts.isIdentifier(node.left) ? node.left.text : ts.isPropertyAccessExpression(node.left) ? node.left.name.text : undefined;
            value = node.right;
        }

        while (value && (ts.isAsExpression(value) || ts.isParenthesizedExpression(value) || ts.isSatisfiesExpression(value))) value = value.expression;
        if (name && value && ts.isStringLiteralLike(value) && credentialValueCheck(name, value.text, SOURCE_MIN_LENGTH)) {
            const { line, column } = lineAndColumn(sourceFile, value.getStart());
            if (!skipLines.has(line - 1)) {
                findings.push(secretFinding(file.relativePath, line, column, 'HIGH', 'MEDIUM', 'Potential secret in source',
                    'A high-entropy string literal is assigned to a credential-like name.', `${name}=[redacted]`));
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return findings;
}

/** String values of credential-like keys in a JSON file. Keys are never inspected, and dependency and author metadata is skipped. */
function scanJsonValues(file: FileContext, skipLines: Set<number>): Finding[] {
    const findings: Finding[] = [];
    const json = ts.parseJsonText(file.relativePath, file.text);
    const root = json.statements[0]?.expression;

    const visit = (node: ts.Node | undefined): void => {
        if (!node) return;
        if (ts.isObjectLiteralExpression(node)) {
            for (const property of node.properties) {
                if (!ts.isPropertyAssignment(property)) continue;
                const key = propertyKey(property.name);
                if (key === undefined || METADATA_KEYS.has(key.toLowerCase())) continue;
                const value = property.initializer;
                if (ts.isStringLiteralLike(value)) {
                    if (!credentialValueCheck(key, value.text, CONFIG_MIN_LENGTH)) continue;
                    const { line, character } = json.getLineAndCharacterOfPosition(value.getStart(json));
                    if (skipLines.has(line)) continue;
                    findings.push(secretFinding(file.relativePath, line + 1, character + 1, 'HIGH', 'MEDIUM', 'Potential secret in source',
                        'A high-entropy value is assigned to a credential-like key.', `${key}=[redacted]`));
                } else {
                    visit(value);
                }
            }
        } else if (ts.isArrayLiteralExpression(node)) {
            node.elements.forEach(visit);
        }
    };
    visit(root);
    return findings;
}

/** `KEY=value` and `key: value` lines in .env, YAML, TOML, INI and similar files. Only the value is judged; a key never is. */
function scanConfigLines(file: FileContext, lines: string[], skipLines: Set<number>): Finding[] {
    const findings: Finding[] = [];
    lines.forEach((line, index) => {
        if (skipLines.has(index) || CONFIG_COMMENT.test(line)) return;
        const match = line.match(CONFIG_ASSIGNMENT);
        if (!match || !credentialValueCheck(match[1], match[2], CONFIG_MIN_LENGTH)) return;
        findings.push(secretFinding(file.relativePath, index + 1, line.indexOf(match[2]) + 1, 'HIGH', 'MEDIUM', 'Potential secret in source',
            'A high-entropy value is assigned to a credential-like key.', `${match[1]}=[redacted]`));
    });
    return findings;
}

function tlsEnvFinding(file: FileContext, lines: string[]): Finding[] {
    const findings: Finding[] = [];
    lines.forEach((line, index) => {
        if (!/NODE_TLS_REJECT_UNAUTHORIZED['"]?\s*[:=]\s*['"]?0/.test(line)) return;
        findings.push(buildFinding({
            ruleId: 'SEC007', category: 'security', severity: 'HIGH', confidence: 'HIGH', file: file.relativePath, line: index + 1, column: 1,
            message: 'TLS certificate verification disabled',
            description: 'NODE_TLS_REJECT_UNAUTHORIZED is set to 0, disabling TLS verification process-wide.',
            evidence: line.trim(), suggestion: 'Remove the override and fix the underlying certificate problem.', fixAvailable: false
        }));
    });
    return findings;
}

export function runSecretScan(context: RuleContext): Finding[] {
    const scanSecrets = isRuleEnabled(context.config, 'SEC001');
    const scanTls = isRuleEnabled(context.config, 'SEC007');
    if (!scanSecrets && !scanTls) return [];

    const findings: Finding[] = [];
    const sourceFiles = new Set(context.files);

    for (const filePath of [...context.files, ...context.textFiles]) {
        const text = readFileSafe(filePath);
        const relativePath = path.relative(context.projectRoot, filePath).replace(/\\/g, '/');
        const lines = text.split(/\r\n|\r|\n/);
        const file: FileContext = {
            relativePath,
            text,
            isTestFixture: isTestFile(relativePath) || /(?:^|\/)(?:fixtures?|__mocks__)(?:\/|$)/i.test(relativePath) ||
                ['test', 'typeTest', 'fixture', 'benchmark', 'example'].includes(classifyFile(relativePath)),
            isDocumentation: DOCUMENTATION_FILE.test(relativePath) || EXAMPLE_CONFIG_FILE.test(path.basename(relativePath))
        };

        if (scanTls) findings.push(...tlsEnvFinding(file, lines));
        if (!scanSecrets) continue;

        const provider = scanProviderTokens(file, lines);
        findings.push(...provider.findings);
        if (file.isTestFixture || file.isDocumentation) continue;

        const sourceFile = sourceFiles.has(filePath) ? context.program.getSourceFile(filePath) : undefined;
        if (sourceFile) findings.push(...scanSourceAssignments(file, sourceFile, provider.reportedLines));
        else if (JSON_FILE.test(relativePath)) findings.push(...scanJsonValues(file, provider.reportedLines));
        else findings.push(...scanConfigLines(file, lines, provider.reportedLines));
    }

    return findings;
}
