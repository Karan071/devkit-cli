import crypto from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import type { RuleContext } from '../context';
import type { Finding, Severity } from '../types';
import { buildFinding } from '../finding';
import { getRuleThreshold, isRuleEnabled } from '../config';

// Identifiers are normalised, so very short windows match declarative boilerplate (`export const X = factory(...)`).
const DEFAULT_MIN_TOKENS = 60;
const WINDOW_STEP = 5;

interface Token {
    text: string;
    line: number;
    kind: ts.SyntaxKind;
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
    startIndexA: number;
    endIndexA: number;
    startIndexB: number;
    /** How many distinct files contain this block; > 2 means repeated boilerplate rather than one copy-paste. */
    copies: number;
}

/**
 * Source ranges that are not extractable logic: imports (near-identical across files by nature) and type-level
 * syntax - type aliases, interfaces, generic parameter lists, overload signatures and `declare`d shapes. Large
 * generic APIs repeat `E2 extends Env = ...` / overload headers dozens of times by necessity; there is nothing to extract.
 */
function nonLogicRanges(sourceFile: ts.SourceFile): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || (ts.isExportDeclaration(node) && !!node.moduleSpecifier)) {
            ranges.push([node.getStart(sourceFile), node.getEnd()]);
            return;
        }
        if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isModuleDeclaration(node) && !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) {
            ranges.push([node.getStart(sourceFile), node.getEnd()]);
            return;
        }
        if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) && !node.body) {
            ranges.push([node.getStart(sourceFile), node.getEnd()]);
            return;
        }
        if ('typeParameters' in node && (node as ts.SignatureDeclaration).typeParameters?.length) {
            const list = (node as ts.SignatureDeclaration).typeParameters!;
            ranges.push([list.pos, list.end]);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return ranges.sort((a, b) => a[0] - b[0]);
}

function tokenize(sourceFile: ts.SourceFile, languageVariant: ts.LanguageVariant): Token[] {
    const scanner = ts.createScanner(ts.ScriptTarget.ES2022, true, languageVariant, sourceFile.text);
    const skipped = nonLogicRanges(sourceFile);
    const tokens: Token[] = [];
    let rangeIndex = 0;
    let kind = scanner.scan();

    while (kind !== ts.SyntaxKind.EndOfFileToken) {
        const pos = scanner.getTokenStart();
        // Ranges are sorted by start; advance past the ones that end before this token (nested ranges are covered by their parent).
        while (rangeIndex < skipped.length && skipped[rangeIndex][1] <= pos) rangeIndex += 1;
        const insideSkipped = skipped.slice(rangeIndex, rangeIndex + 8).some(([start, end]) => pos >= start && pos < end);
        if (!insideSkipped) {
            tokens.push({ text: scanner.getTokenText(), line: sourceFile.getLineAndCharacterOfPosition(pos).line + 1, kind });
        }
        kind = scanner.scan();
    }

    return tokens;
}

export function normalizeWindow(window: Token[]): string {
    const identifiers = new Map<string, string>();
    let nextIdentifier = 0;
    return window.map((token) => {
        if (token.kind !== ts.SyntaxKind.Identifier && token.kind !== ts.SyntaxKind.PrivateIdentifier) return token.text;
        if (!identifiers.has(token.text)) identifiers.set(token.text, `IDENT_${nextIdentifier++}`);
        return identifiers.get(token.text)!;
    }).join('\u0001');
}

function severityForSpan(spanTokens: number, minTokens: number): Severity {
    if (spanTokens >= minTokens * 4) return 'HIGH';
    if (spanTokens >= minTokens * 2) return 'MEDIUM';
    return 'LOW';
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
    const sorted = [...ranges].sort((a, b) => a.startIndexA - b.startIndexA || a.startIndexB - b.startIndexB);
    const merged: MatchRange[] = [];

    for (const range of sorted) {
        const last = merged[merged.length - 1];
        // Consecutive windows of the same clone advance by the same offset on both sides.
        const sameClone = last && range.startIndexA <= last.endIndexA && range.startIndexB - range.startIndexA === last.startIndexB - last.startIndexA;
        if (sameClone) {
            last.endIndexA = Math.max(last.endIndexA, range.endIndexA);
            last.endLineA = Math.max(last.endLineA, range.endLineA);
            last.endLineB = Math.max(last.endLineB, range.endLineB);
            last.copies = Math.max(last.copies, range.copies);
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
            const joined = normalizeWindow(window);
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

        // A block present in many files (locale tables, generated-looking adapters) is one pattern, not
        // N*(N-1)/2 copy-pastes. Report it once, between the first two files, with the true count.
        const distinctFiles = new Set(entries.map((entry) => entry.file));
        const copies = distinctFiles.size;
        const compared = copies >= 3
            ? entries.filter((entry, index) => index === 0 || (entry.file !== entries[0].file && entries.findIndex((other) => other.file === entry.file) === index)).slice(0, 2)
            : entries;

        for (let i = 0; i < compared.length; i += 1) {
            for (let j = i + 1; j < compared.length; j += 1) {
                const a = compared[i];
                const b = compared[j];
                // Within one file, overlapping windows are repetitive code, not a copy-paste.
                if (a.file === b.file && Math.abs(a.startIndex - b.startIndex) < minTokens) continue;

                const key = a.file <= b.file ? `${a.file}::${b.file}` : `${b.file}::${a.file}`;
                const [first, second] = a.file <= b.file ? [a, b] : [b, a];

                if (!pairRanges.has(key)) pairRanges.set(key, []);
                pairRanges.get(key)!.push({
                    startLineA: first.startLine,
                    endLineA: first.endLine,
                    startLineB: second.startLine,
                    endLineB: second.endLine,
                    startIndexA: first.startIndex,
                    endIndexA: first.startIndex + minTokens,
                    startIndexB: second.startIndex,
                    copies
                });
            }
        }
    }

    const findings: Finding[] = [];

    for (const [key, ranges] of pairRanges) {
        const [fileA, fileB] = key.split('::');
        const merged = mergeRanges(ranges);

        for (const range of merged) {
            const spanTokens = range.endIndexA - range.startIndexA;
            // Repetition inside one file is usually a local pattern (a family of similar declarations), so it
            // has to be substantially larger than the minimum before it reads as copy-paste.
            if (fileA === fileB && spanTokens < minTokens * 2) continue;

            findings.push(
                buildFinding({
                    ruleId: 'DUP001',
                    category: 'duplication',
                    severity: severityForSpan(spanTokens, minTokens),
                    confidence: range.copies >= 3 ? 'LOW' : 'MEDIUM',
                    file: fileA,
                    line: range.startLineA,
                    column: 1,
                    message: 'Duplicate code block',
                    description: `Lines ${range.startLineA}-${range.endLineA} closely match ${fileB}:${range.startLineB}-${range.endLineB}.${range.copies >= 3 ? ` The same block appears in ${range.copies} files, so it is likely intentional repetition (data tables, adapters).` : ''}`,
                    evidence: `${fileB}:${range.startLineB}-${range.endLineB}`,
                    suggestion: 'Extract the shared logic into a reusable function or module.',
                    fixAvailable: false
                })
            );
        }
    }

    return findings;
}
