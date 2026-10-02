import ts from 'typescript';

export function forEachNode(root: ts.Node, visitor: (node: ts.Node) => void): void {
    visitor(root);
    ts.forEachChild(root, (child) => forEachNode(child, visitor));
}

export function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
    return (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)
    );
}

export function getFunctionName(node: ts.FunctionLikeDeclaration): string {
    if (node.name && ts.isIdentifier(node.name)) {
        return node.name.text;
    }

    if (ts.isConstructorDeclaration(node)) {
        return 'constructor';
    }

    const parent = node.parent;
    if (parent) {
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
            return parent.name.text;
        }
        if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
            return parent.name.text;
        }
        if (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) {
            return parent.name.text;
        }
    }

    return 'anonymous';
}

export function lineAndColumn(sourceFile: ts.SourceFile, pos: number): { line: number; column: number } {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
    return { line: line + 1, column: character + 1 };
}

export function findNodeAtPosition(root: ts.Node, pos: number): ts.Node {
    let best: ts.Node = root;

    const visit = (node: ts.Node): void => {
        if (pos < node.getFullStart() || pos >= node.getEnd()) {
            return;
        }
        best = node;
        ts.forEachChild(node, visit);
    };

    visit(root);
    return best;
}

export type StatementContainer = ts.Block | ts.SourceFile | ts.CaseClause | ts.DefaultClause | ts.ModuleBlock;

export function isStatementContainer(node: ts.Node): node is StatementContainer {
    return (
        ts.isBlock(node) ||
        ts.isSourceFile(node) ||
        ts.isCaseClause(node) ||
        ts.isDefaultClause(node) ||
        ts.isModuleBlock(node)
    );
}
