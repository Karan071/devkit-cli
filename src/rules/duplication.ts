import crypto from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import type { RuleContext } from '../context';
import type { Finding, Severity } from '../types';
import { buildFinding } from '../finding';
import { getRuleThreshold, isRuleEnabled } from '../config';

const DEFAULT_MIN_TOKENS = 40;
const WINDOW_STEP = 5;

interface Token {
    text: string;
    line: number;
}

interface WindowEntry {
    file: string;
    startLine: number;
    endLine: number;
    startIndex: number;
}

interface MatchRange {
    startLineA: number;
    endLineA: number;
    startLineB: number;
    endLineB: number;
}

function tokenize(sourceFile: ts.SourceFile, languageVariant: ts.LanguageVariant): Token[] {
    const scanner = ts.createScanner(ts.ScriptTarget.ES2022, true, languageVariant, sourceFile.text);
    const tokens: Token[] = [];
    let kind = scanner.scan();

    while (kind !== ts.SyntaxKind.EndOfFileToken) {
        const pos = scanner.getTokenStart();
        tokens.push({ text: scanner.getTokenText(), line: sourceFile.getLineAndCharacterOfPosition(pos).line + 1 });
        kind = scanner.scan();
    }

    return tokens;
}

function severityForSpan(spanTokens: number, minTokens: number): Severity {
    if (spanTokens >= minTokens * 4) return 'HIGH';
    if (spanTokens >= minTokens * 2) return 'MEDIUM';
    return 'LOW';
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
    const sorted = [...ranges].sort((a, b) => a.startLineA - b.startLineA);
    const merged: MatchRange[] = [];

    for (const range of sorted) {
        const last = merged[merged.length - 1];
        if (last && range.startLineA <= last.endLineA + 1 && range.startLineB <= last.endLineB + 1) {
            last.endLineA = Math.max(last.endLineA, range.endLineA);
            last.endLineB = Math.max(last.endLineB, range.endLineB);
        } else {
            merged.push({ ...range });
        }
    }

    return merged;
}

export function runDuplicationRules(context: RuleContext): Finding[] {
    if (!isRuleEnabled(context.config, 'DUP001')) {
        return [];
    }

    const minTokens = getRuleThreshold(context.config, 'DUP001', DEFAULT_MIN_TOKENS);
    const hashBuckets = new Map<string, WindowEntry[]>();

    const relPath = (file: string) => path.relative(context.projectRoot, file).replace(/\\/g, '/');

    for (const file of context.files) {
        const sourceFile = context.program.getSourceFile(file);
        if (!sourceFile) continue;

        const variant = /\.(tsx|jsx)$/i.test(file) ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
        const tokens = tokenize(sourceFile, variant);
        if (tokens.length < minTokens) continue;

        const relative = relPath(file);

        for (let i = 0; i + minTokens <= tokens.length; i += WINDOW_STEP) {
            const window = tokens.slice(i, i + minTokens);
            const joined = window.map((token) => token.text).join('\u0001');
            const hash = crypto.createHash('sha1').update(joined).digest('hex');
            const entry: WindowEntry = {
                file: relative,
                startLine: window[0].line,
                endLine: window[window.length - 1].line,
                startIndex: i
            };

            if (!hashBuckets.has(hash)) hashBuckets.set(hash, []);
            hashBuckets.get(hash)!.push(entry);
        }
    }

    const pairRanges = new Map<string, MatchRange[]>();

    for (const entries of hashBuckets.values()) {
        if (entries.length < 2) continue;

        for (let i = 0; i < entries.length; i += 1) {
            for (let j = i + 1; j < entries.length; j += 1) {
                const a = entries[i];
                const b = entries[j];
                if (a.file === b.file && a.startIndex === b.startIndex) continue;

                const key = a.file <= b.file ? `${a.file}::${b.file}` : `${b.file}::${a.file}`;
                const [first, second] = a.file <= b.file ? [a, b] : [b, a];

                if (!pairRanges.has(key)) pairRanges.set(key, []);
                pairRanges.get(key)!.push({
                    startLineA: first.startLine,
                    endLineA: first.endLine,
                    startLineB: second.startLine,
                    endLineB: second.endLine
                });
            }
        }
    }

    const findings: Finding[] = [];

    for (const [key, ranges] of pairRanges) {
        const [fileA, fileB] = key.split('::');
        const merged = mergeRanges(ranges);

        for (const range of merged) {
            const spanLines = range.endLineA - range.startLineA + 1;
            if (spanLines * WINDOW_STEP < minTokens) continue;

            findings.push(
                buildFinding({
                    ruleId: 'DUP001',
                    category: 'duplication',
                    severity: severityForSpan(spanLines * WINDOW_STEP, minTokens),
                    confidence: 'MEDIUM',
                    file: fileA,
                    line: range.startLineA,
                    column: 1,
                    message: 'Duplicate code block',
                    description: `Lines ${range.startLineA}-${range.endLineA} closely match ${fileB}:${range.startLineB}-${range.endLineB}.`,
                    evidence: `${fileB}:${range.startLineB}-${range.endLineB}`,
                    suggestion: 'Extract the shared logic into a reusable function or module.',
                    fixAvailable: false
                })
            );
        }
    }

    return findings;
}
