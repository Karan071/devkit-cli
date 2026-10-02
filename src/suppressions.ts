import ts from 'typescript';
import { collectCommentRanges } from './ast/comments';

export interface SuppressionDirective {
    line: number;
    ruleIds: Set<string> | null;
}

export interface FileSuppression {
    ruleIds: Set<string> | null;
}

const RULE_ID_LIST = '([A-Z]{2,}\\d{3}(?:\\s*,\\s*[A-Z]{2,}\\d{3})*)';
const NEXT_LINE_PATTERN = new RegExp(`devkit-disable-next-line(?:\\s+${RULE_ID_LIST})?`, 'i');
const FILE_PATTERN = new RegExp(`devkit-disable-file(?:\\s+${RULE_ID_LIST})?`, 'i');

function parseRuleIdList(match: RegExpExecArray): Set<string> | null {
    return match[1] ? new Set(match[1].split(',').map((id) => id.trim().toUpperCase())) : null;
}

export function collectSuppressions(sourceFile: ts.SourceFile): SuppressionDirective[] {
    const directives: SuppressionDirective[] = [];
    for (const range of collectCommentRanges(sourceFile)) {
        const text = sourceFile.text.slice(range.pos, range.end);
        const match = NEXT_LINE_PATTERN.exec(text);
        if (!match) continue;
        const line = sourceFile.getLineAndCharacterOfPosition(range.end).line + 2;
        directives.push({ line, ruleIds: parseRuleIdList(match) });
    }
    return directives;
}

/**
 * `// devkit-disable-file` (optionally followed by rule IDs) anywhere in a file silences those
 * rules for the whole file — for a vendored copy, a generated-looking file that content
 * detection missed, or a file a team has deliberately decided not to clean up yet.
 */
export function collectFileSuppression(sourceFile: ts.SourceFile): FileSuppression | null {
    for (const range of collectCommentRanges(sourceFile)) {
        const match = FILE_PATTERN.exec(sourceFile.text.slice(range.pos, range.end));
        if (match) return { ruleIds: parseRuleIdList(match) };
    }
    return null;
}

export function isSuppressed(sourceFile: ts.SourceFile, line: number, ruleId: string): boolean {
    const upperRuleId = ruleId.toUpperCase();
    const fileSuppression = collectFileSuppression(sourceFile);
    if (fileSuppression && (!fileSuppression.ruleIds || fileSuppression.ruleIds.has(upperRuleId))) {
        return true;
    }
    return collectSuppressions(sourceFile).some((directive) => directive.line === line && (!directive.ruleIds || directive.ruleIds.has(upperRuleId)));
}
