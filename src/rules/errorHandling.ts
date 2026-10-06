import path from 'node:path';
import ts from 'typescript';
import type { RuleContext } from '../context';
import type { Finding } from '../types';
import { buildFinding } from '../finding';
import { isRuleEnabled } from '../config';
import { lineAndColumn } from '../ast/walk';

/**
 * A value is Promise-like only when its `then` follows the Promises/A+ shape: it accepts both a
 * fulfilment and a rejection callback. Single-callback "thenables" (animation tweens, query builders)
 * can't produce an unhandled rejection, so reporting them is noise.
 */
function isPromiseLike(checker: ts.TypeChecker, expression: ts.Expression): boolean {
    let type: ts.Type;
    try { type = checker.getTypeAtLocation(expression); } catch { return false; }
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
    const members = type.isUnion() ? type.types : [type];
    return members.some((member) => {
        const thenProperty = checker.getPropertyOfType(member, 'then');
        if (!thenProperty) return false;
        const thenType = checker.getTypeOfSymbolAtLocation(thenProperty, expression);
        return checker.getSignaturesOfType(thenType, ts.SignatureKind.Call).some((signature) => signature.parameters.length >= 2);
    });
}

/** `(async () => { try { ... } catch { ... } })()`: the function handles its own failures, so nothing can reject. */
function isSelfHandlingAsyncIife(call: ts.CallExpression): boolean {
    let callee: ts.Expression = call.expression;
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
    if (!ts.isArrowFunction(callee) && !ts.isFunctionExpression(callee)) return false;
    if (!ts.isBlock(callee.body)) return false;
    return callee.body.statements.some((statement) => ts.isTryStatement(statement) && !!statement.catchClause);
}

/**
 * Calls that hand back what they were given (`Object.assign(promise, extras)`, fluent `reply.code().send()`)
 * are being used for their side effects; the returned value is the same object, not a new promise to await.
 */
function returnsItsInput(checker: ts.TypeChecker, call: ts.CallExpression): boolean {
    let result: ts.Type;
    try { result = checker.getTypeAtLocation(call); } catch { return false; }
    const typeOf = (expression: ts.Expression): ts.Type | null => {
        try { return checker.getTypeAtLocation(expression); } catch { return null; }
    };

    // Static helper handing back its first argument (`Object.assign(promise, extras)`, `Object.defineProperties(x, d)`):
    // the very same type instance comes back, so the call decorates an object rather than starting new async work.
    const firstArgument = call.arguments[0] ? typeOf(call.arguments[0]) : null;
    if (firstArgument && result === firstArgument) return true;

    // Fluent method returning its own receiver type (`reply.code(200).send(...)`). A real Promise chained off a
    // Promise (`p.finally(...)`) is exactly the case the rule exists for, so Promise receivers never qualify.
    if (ts.isPropertyAccessExpression(call.expression)) {
        const receiver = typeOf(call.expression.expression);
        const symbol = result.getSymbol();
        if (receiver && symbol && symbol.getName() !== 'Promise' && (result === receiver || symbol === receiver.getSymbol())) return true;
    }
    return false;
}

function outerPromiseChain(node: ts.CallExpression): ts.CallExpression {
    let current: ts.Node = node;
    while (current.parent) {
        if (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current) {
            current = current.parent;
            continue;
        }
        if (ts.isCallExpression(current.parent) && current.parent.expression === current) {
            current = current.parent;
            continue;
        }
        break;
    }
    return ts.isCallExpression(current) ? current : node;
}

function propertyCallName(call: ts.CallExpression): string | null {
    return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null;
}

function promiseChainHasCatch(call: ts.CallExpression): boolean {
    let current: ts.Node = call;
    while (ts.isCallExpression(current)) {
        if (propertyCallName(current) === 'catch') return true;
        if (!ts.isPropertyAccessExpression(current.expression)) return false;
        current = current.expression.expression;
    }
    return false;
}

export function runErrorHandlingRules(context: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const checker = context.program.getTypeChecker();

    for (const file of context.files) {
        const sourceFile = context.program.getSourceFile(file);
        if (!sourceFile) continue;
        const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');

        const visit = (node: ts.Node): void => {
            if (ts.isCatchClause(node)) {
                const statements = node.block.statements;
                // A comment inside the block documents an intentional ignore, which is what the rule asks for.
                const documented = /\/\/|\/\*/.test(node.block.getText());
                if (isRuleEnabled(context.config, 'ERR001') && statements.length === 0 && !documented) {
                    const { line, column } = lineAndColumn(sourceFile, node.getStart());
                    findings.push(buildFinding({
                        ruleId: 'ERR001', category: 'errorHandling', severity: 'MEDIUM', confidence: 'CERTAIN', file: relativePath, line, column,
                        message: 'Empty catch block', description: 'An exception is caught and silently discarded.', evidence: node.getText().slice(0, 160),
                        suggestion: 'Handle the error, log it, or document why it is intentionally ignored.', fixAvailable: false
                    }));
                }
                if (isRuleEnabled(context.config, 'ERR002') && statements.length === 1 && ts.isThrowStatement(statements[0])) {
                    const throwStatement = statements[0];
                    const catchVarName = node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name) ? node.variableDeclaration.name.text : undefined;
                    const rethrowsSameValue = !throwStatement.expression || (catchVarName && ts.isIdentifier(throwStatement.expression) && throwStatement.expression.text === catchVarName);
                    if (rethrowsSameValue) {
                        const { line, column } = lineAndColumn(sourceFile, node.getStart());
                        findings.push(buildFinding({
                            ruleId: 'ERR002', category: 'errorHandling', severity: 'LOW', confidence: 'HIGH', file: relativePath, line, column,
                            message: 'Catch-and-rethrow without modification', description: 'The catch block only rethrows the original error, adding no value.',
                            evidence: node.getText().slice(0, 160), suggestion: 'Remove the try/catch, or add meaningful handling (logging, wrapping, recovery).', fixAvailable: false
                        }));
                    }
                }
            }

            if (isRuleEnabled(context.config, 'ERR003') && ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
                const call = node.expression;
                if (propertyCallName(call) !== 'then' && !promiseChainHasCatch(call) && isPromiseLike(checker, call) && !isSelfHandlingAsyncIife(call) && !returnsItsInput(checker, call)) {
                    const { line, column } = lineAndColumn(sourceFile, node.getStart());
                    findings.push(buildFinding({
                        ruleId: 'ERR003', category: 'errorHandling', severity: 'MEDIUM', confidence: 'HIGH', file: relativePath, line, column,
                        message: 'Floating promise', description: 'The result of this Promise-like call is neither awaited nor handled.', evidence: node.getText().slice(0, 160),
                        suggestion: 'Add await, or explicitly handle rejection with .catch().', fixAvailable: false
                    }));
                }
            }

            // `.then(onFulfilled, onRejected)` already handles rejection; only the one-callback form can leak it.
            if (isRuleEnabled(context.config, 'ERR004') && ts.isCallExpression(node) && propertyCallName(node) === 'then' && node.arguments.length < 2) {
                const chain = outerPromiseChain(node);
                if (chain === node && propertyCallName(chain) !== 'catch') {
                    const statement = ts.findAncestor(chain, ts.isExpressionStatement);
                    if (statement && statement.expression === chain) {
                        const { line, column } = lineAndColumn(sourceFile, node.getStart());
                        findings.push(buildFinding({
                            ruleId: 'ERR004', category: 'errorHandling', severity: 'MEDIUM', confidence: 'MEDIUM', file: relativePath, line, column,
                            message: 'Promise chain has no rejection handler', description: 'This .then() chain is not followed by .catch(), so a rejected Promise may go unhandled.',
                            evidence: statement.getText().slice(0, 160), suggestion: 'Add a .catch() handler or use try/catch with await.', fixAvailable: false
                        }));
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }
    return findings;
}
