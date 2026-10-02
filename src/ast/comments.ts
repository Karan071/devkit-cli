import ts from 'typescript';

const COMMENT_RANGE_CACHE = new WeakMap<ts.SourceFile, ts.CommentRange[]>();

export function collectCommentRanges(sourceFile: ts.SourceFile): ts.CommentRange[] {
    const cached = COMMENT_RANGE_CACHE.get(sourceFile);
    if (cached) return cached;
    const ranges = new Map<string, ts.CommentRange>();
    const addAt = (position: number): void => {
        for (const range of ts.getLeadingCommentRanges(sourceFile.text, position) ?? []) {
            ranges.set(`${range.pos}:${range.end}`, range);
        }
    };
    addAt(sourceFile.getFullStart());
    const visit = (node: ts.Node): void => {
        addAt(node.getFullStart());
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    const result = [...ranges.values()].sort((a, b) => a.pos - b.pos);
    COMMENT_RANGE_CACHE.set(sourceFile, result);
    return result;
}
