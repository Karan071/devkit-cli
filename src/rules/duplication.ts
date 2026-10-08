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
// Translation tables and test data repeat by design: a duplicate there is a pattern, not a copy-paste.
const REPETITIVE_DIRECTORY = /(?:^|\/)(?:locales?|i18n|l10n|lang|langs|translations?|fixtures?|__fixtures__|testdata|test-data)\//i;
// A window dominated by literals (or with next to no logic) is a data table; there is no function to extract.
const DATA_LITERAL_SHARE = 0.3;
const MIN_LOGIC_SHARE = 0.1;

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

const LITERAL_KINDS = new Set([
    ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.BigIntLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.RegularExpressionLiteral, ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail
]);

// Inside TypeScript's binary-operator range, but structure of data (`key: value`, decorators), not logic.
const DATA_PUNCTUATION = new Set([ts.SyntaxKind.CommaToken, ts.SyntaxKind.ColonToken, ts.SyntaxKind.AtToken]);

function isLogicToken(kind: ts.SyntaxKind): boolean {
    return (kind >= ts.SyntaxKind.FirstReservedWord && kind <= ts.SyntaxKind.LastReservedWord) ||
        (kind >= ts.SyntaxKind.FirstBinaryOperator && kind <= ts.SyntaxKind.LastBinaryOperator && !DATA_PUNCTUATION.has(kind)) ||
        kind === ts.SyntaxKind.OpenParenToken || kind === ts.SyntaxKind.EqualsGreaterThanToken || kind === ts.SyntaxKind.DotToken ||
        kind === ts.SyntaxKind.QuestionToken || kind === ts.SyntaxKind.ExclamationToken;
}

/** Whether a window of tokens is mostly literal data, or has almost no operators, calls or keywords. */
export function isDataWindow(window: Token[]): boolean {
    const literals = window.filter((token) => LITERAL_KINDS.has(token.kind)).length;
    const logic = window.filter((token) => isLogicToken(token.kind)).length;
    return literals / window.length >= DATA_LITERAL_SHARE || logic / window.length < MIN_LOGIC_SHARE;
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
        if (REPETITIVE_DIRECTORY.test(relative)) continue;

        for (let i = 0; i + minTokens <= tokens.length; i += WINDOW_STEP) {
            const window = tokens.slice(i, i + minTokens);
            if (isDataWindow(window)) continue;
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

        // A block present in many files is one pattern, not N*(N-1)/2 copy-pastes.
        const distinctFiles = new Set(entries.map((entry) => entry.file));
        const copies = distinctFiles.size;
        // One entry per file. With three or more files the first is compared to each of the others (a star), which
        // links them all into one cluster without N*(N-1)/2 pairs.
        const perFile = entries.filter((entry, index) => entries.findIndex((other) => other.file === entry.file) === index);
        const pairs: Array<[WindowEntry, WindowEntry]> = [];
        if (copies >= 3) for (const other of perFile.slice(1)) pairs.push([perFile[0], other]);
        else for (let i = 0; i < entries.length; i += 1) for (let j = i + 1; j < entries.length; j += 1) pairs.push([entries[i], entries[j]]);

        for (const [a, b] of pairs) {
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

    return clusterFindings(pairRanges, minTokens);
}

interface Block {
    file: string;
    start: number;
    end: number;
}

/**
 * One finding per cluster of mutually duplicated code, not one per pair. A function copied into five files, or a
 * family of near-identical files, is a single problem; reporting every pair buries it under hundreds of findings.
 */
function clusterFindings(pairRanges: Map<string, MatchRange[]>, minTokens: number): Finding[] {
    const blocks: Block[] = [];
    const parent: number[] = [];
    const find = (index: number): number => {
        while (parent[index] !== index) {
            parent[index] = parent[parent[index]];
            index = parent[index];
        }
        return index;
    };
    const union = (a: number, b: number): void => { parent[find(a)] = find(b); };
    const addBlock = (file: string, start: number, end: number): number => {
        blocks.push({ file, start, end });
        parent.push(blocks.length - 1);
        return blocks.length - 1;
    };

    const spans = new Map<number, { tokens: number; copies: number }>();
    for (const [key, ranges] of pairRanges) {
        const [fileA, fileB] = key.split('::');
        for (const range of mergeRanges(ranges)) {
            const spanTokens = range.endIndexA - range.startIndexA;
            // Repetition inside one file is usually a local pattern (a family of similar declarations), so it
            // has to be substantially larger than the minimum before it reads as copy-paste.
            if (fileA === fileB && spanTokens < minTokens * 2) continue;
            const a = addBlock(fileA, range.startLineA, range.endLineA);
            const b = addBlock(fileB, range.startLineB, range.endLineB);
            union(a, b);
            spans.set(a, { tokens: spanTokens, copies: range.copies });
        }
    }

    // Overlapping blocks of one file (found through different partners) are the same code.
    const byFile = new Map<string, number[]>();
    blocks.forEach((block, index) => byFile.set(block.file, [...(byFile.get(block.file) ?? []), index]));
    for (const indexes of byFile.values()) {
        const sorted = [...indexes].sort((x, y) => blocks[x].start - blocks[y].start);
        let reach = sorted.length > 0 ? blocks[sorted[0]].end : 0;
        let anchor = sorted[0];
        for (const index of sorted.slice(1)) {
            if (blocks[index].start <= reach) union(anchor, index);
            else anchor = index;
            reach = Math.max(reach, blocks[index].end);
        }
    }

    const clusters = new Map<number, number[]>();
    blocks.forEach((_, index) => clusters.set(find(index), [...(clusters.get(find(index)) ?? []), index]));

    const findings: Finding[] = [];
    for (const members of clusters.values()) {
        // Collapse overlapping blocks into the places they cover.
        const places: Block[] = [];
        for (const block of members.map((index) => blocks[index]).sort((x, y) => x.file.localeCompare(y.file) || x.start - y.start)) {
            const last = places[places.length - 1];
            if (last && last.file === block.file && block.start <= last.end) last.end = Math.max(last.end, block.end);
            else places.push({ ...block });
        }
        if (places.length < 2) continue;

        const [primary, ...others] = places;
        const spanTokens = Math.max(...members.map((index) => spans.get(index)?.tokens ?? 0));
        const copies = Math.max(...members.map((index) => spans.get(index)?.copies ?? 2), new Set(places.map((place) => place.file)).size);
        const shown = others.slice(0, 4).map((place) => `${place.file}:${place.start}-${place.end}`);
        const more = others.length > shown.length ? ` and ${others.length - shown.length} more` : '';

        findings.push(
            buildFinding({
                ruleId: 'DUP001',
                category: 'duplication',
                severity: severityForSpan(spanTokens, minTokens),
                confidence: copies >= 3 ? 'LOW' : 'MEDIUM',
                file: primary.file,
                line: primary.start,
                column: 1,
                message: 'Duplicate code block',
                description: `Lines ${primary.start}-${primary.end} closely match ${shown[0]}.${others.length > 1 ? ` The same code appears in ${places.length} places: ${shown.join(', ')}${more}.` : ''}${copies >= 3 ? ' With this many copies it is likely intentional repetition (adapters, per-type variants).' : ''}`,
                evidence: shown[0],
                suggestion: 'Extract the shared logic into a reusable function or module.',
                fixAvailable: false
            })
        );
    }

    return findings;
}
