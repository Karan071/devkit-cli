import ts from 'typescript';
import { collectCommentRanges } from './ast/comments';

export interface SuppressionDirective {
    line: number;
    ruleIds: Set<string> | null;
}

export function collectSuppressions(sourceFile: ts.SourceFile): SuppressionDirective[] {
    const directives: SuppressionDirective[] = [];
    for (const range of collectCommentRanges(sourceFile)) {
        const text = sourceFile.text.slice(range.pos, range.end);
        const match = /devkit-disable-next-line(?:\s+([A-Z]{2,}\d{3}(?:\s*,\s*[A-Z]{2,}\d{3})*))?/i.exec(text);
        if (!match) continue;
        const line = sourceFile.getLineAndCharacterOfPosition(range.end).line + 2;
        const ruleIds = match[1] ? new Set(match[1].split(',').map((id) => id.trim().toUpperCase())) : null;
        directives.push({ line, ruleIds });
    }
    return directives;
}

export function isSuppressed(sourceFile: ts.SourceFile, line: number, ruleId: string): boolean {
    return collectSuppressions(sourceFile).some((directive) => directive.line === line && (!directive.ruleIds || directive.ruleIds.has(ruleId.toUpperCase())));
}
