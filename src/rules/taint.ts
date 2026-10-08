import path from 'node:path';
import ts from 'typescript';
import type { RuleContext } from '../context';
import type { Confidence, Finding, Severity } from '../types';
import { buildFinding } from '../finding';
import { isRuleEnabled } from '../config';
import { readFileSafe } from '../discovery';
import { lineAndColumn } from '../ast/walk';
import { EXEC_FUNCTION_NAMES, FILE_FUNCTION_NAMES, SHELL_FUNCTION_NAMES, SQL_FUNCTION_NAMES, calleeName, importedCalleeName, mayBeShellExecution } from './securityHelpers';

/**
 * Taint tracking: follows request-controlled data (Express/Koa/Hono/Next/Nest inputs and `process.argv`) through
 * variables, string building, destructuring and function calls to the calls where it does damage.
 *
 * It is deliberately a function-level analysis on top of the type checker's symbols, not a full data-flow engine:
 *  - values flow through assignments, templates, concatenation, property reads and known pass-through methods;
 *  - calls to functions in the project use a per-function summary (which parameters reach which sinks, and what the
 *    function returns), so a flow across helper functions and files is found without inlining;
 *  - known cleaning steps (numeric parsing, schema validation, path.basename, allowlist and format checks that exit
 *    early) stop a flow, and each cleaning step only counts for the kinds of sink it actually protects.
 */

export type SinkKind = 'command' | 'code' | 'path' | 'sql' | 'ssrf' | 'redirect' | 'regexp' | 'pollution';
const ALL_KINDS: readonly SinkKind[] = ['command', 'code', 'path', 'sql', 'ssrf', 'redirect', 'regexp', 'pollution'];

type Origin = { type: 'source'; label: string; local: boolean } | { type: 'param'; index: number };

interface Taint {
    origins: Origin[];
    /** Sink kinds this value has been made safe for. */
    clean: ReadonlySet<SinkKind>;
    /** Whether the tainted part comes first, so it controls the host of a URL rather than only a path segment. */
    leading: boolean;
    /** Whether fixed text follows the tainted part (`dir + name + '.yml'`), which limits what an attacker can reach. */
    suffixed?: boolean;
    trace: string[];
}

interface Hit {
    kind: SinkKind;
    node: ts.Node;
    label: string;
    taint: Taint;
    /** Where the data goes after the call, when the sink is inside a function that was called. */
    via?: { callee: string; file: string; line: number };
}

interface Summary {
    paramHits: Map<number, Hit[]>;
    returns?: Taint;
}

const NO_KINDS: ReadonlySet<SinkKind> = new Set();
const EVERYTHING: ReadonlySet<SinkKind> = new Set(ALL_KINDS);

const originKey = (origin: Origin): string => (origin.type === 'source' ? `s:${origin.label}` : `p:${origin.index}`);

function union(...taints: Array<Taint | undefined>): Taint | undefined {
    const present = taints.filter((taint): taint is Taint => !!taint);
    if (present.length === 0) return undefined;
    if (present.length === 1) return present[0];
    const origins = new Map<string, Origin>();
    for (const taint of present) for (const origin of taint.origins) origins.set(originKey(origin), origin);
    // A mix is only safe for a kind when every part of it is.
    const clean = new Set<SinkKind>(ALL_KINDS.filter((kind) => present.every((taint) => taint.clean.has(kind))));
    return { origins: [...origins.values()], clean, leading: present.some((taint) => taint.leading), suffixed: present.every((taint) => taint.suffixed), trace: present[0].trace };
}

const makeCleanOrUndefined = (taint: Taint | undefined): Taint | undefined => (taint ? makeClean(taint, ALL_KINDS) : undefined);

const extend = (taint: Taint, step: string): Taint => (taint.trace.length >= 6 || taint.trace[taint.trace.length - 1] === step ? taint : { ...taint, trace: [...taint.trace, step] });
const makeClean = (taint: Taint, kinds: Iterable<SinkKind>): Taint => ({ ...taint, clean: new Set([...taint.clean, ...kinds]) });

// ---- sources -------------------------------------------------------------------------------------------------

const REQUEST_NAMES = new Set(['req', 'request']);
const REQUEST_PROPERTIES = new Set(['params', 'query', 'body', 'headers', 'cookies', 'signedCookies', 'url', 'originalUrl', 'path', 'hostname', 'host', 'files', 'file', 'nextUrl']);
const REQUEST_METHODS = new Set(['get', 'header', 'param', 'json', 'text', 'formData', 'arrayBuffer', 'blob']);
const CONTEXT_NAMES = new Set(['ctx', 'context']);
const CONTEXT_PROPERTIES = new Set(['query', 'params', 'querystring', 'headers', 'url', 'path', 'href', 'search', 'hostname']);
const HONO_METHODS = new Set(['query', 'queries', 'param', 'header', 'json', 'text', 'parseBody', 'formData', 'arrayBuffer', 'blob', 'url', 'path']);
const DECORATED_SOURCES = new Set(['Body', 'Query', 'Param', 'Headers', 'Req', 'Request', 'Ip', 'HostParam', 'UploadedFile', 'UploadedFiles']);

function identifierText(expression: ts.Expression): string | undefined {
    return ts.isIdentifier(expression) ? expression.text : undefined;
}

function sourceOf(expression: ts.Expression): Taint | undefined {
    const make = (label: string, local = false): Taint => ({ origins: [{ type: 'source', label, local }], clean: NO_KINDS, leading: true, trace: [label] });

    if (ts.isPropertyAccessExpression(expression)) {
        const base = expression.expression;
        const name = expression.name.text;
        const baseName = identifierText(base);
        if (baseName && REQUEST_NAMES.has(baseName) && REQUEST_PROPERTIES.has(name)) return make(`${baseName}.${name}`);
        if (baseName && CONTEXT_NAMES.has(baseName) && CONTEXT_PROPERTIES.has(name)) return make(`${baseName}.${name}`);
        if (ts.isPropertyAccessExpression(base) && identifierText(base.expression) && CONTEXT_NAMES.has(identifierText(base.expression)!) && base.name.text === 'request' && REQUEST_PROPERTIES.has(name)) {
            return make(`${identifierText(base.expression)}.request.${name}`);
        }
        if (baseName === 'process' && name === 'argv') return make('process.argv', true);
    }

    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
        const method = expression.expression.name.text;
        const receiver = expression.expression.expression;
        const receiverName = identifierText(receiver);
        if (receiverName && REQUEST_NAMES.has(receiverName) && REQUEST_METHODS.has(method)) return make(`${receiverName}.${method}()`);
        // Hono: c.req.query('id'), await c.req.json(). `valid()` returns validator output and is not a source.
        if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'req' && HONO_METHODS.has(method)) {
            const contextName = identifierText(receiver.expression);
            if (contextName && (contextName === 'c' || CONTEXT_NAMES.has(contextName))) return make(`${contextName}.req.${method}()`);
        }
    }
    return undefined;
}

// ---- sanitizers ----------------------------------------------------------------------------------------------

const NUMERIC_CONVERTERS = new Set(['parseInt', 'parseFloat', 'Number', 'Boolean', 'BigInt']);
const PATH_SANITIZERS = new Set(['basename', 'sanitizeFilename', 'sanitize', 'slugify', 'encodeURIComponent', 'encodeURI']);
const SQL_ESCAPERS = new Set(['escape', 'escapeId', 'escapeLiteral', 'escapeIdentifier']);
const SHELL_ESCAPERS = new Set(['shellEscape', 'shellescape', 'escapeShellArg', 'escapeShell', 'shQuote']);
const REGEXP_ESCAPERS = new Set(['escapeRegExp', 'escapeRegex', 'escapeStringRegexp']);
const SCHEMA_RECEIVER = /(^|\.)z\b|[sS]chema$|[vV]alidator$|^[A-Za-z]*Dto$/;
const SCHEMA_METHODS = new Set(['parse', 'parseAsync', 'safeParse', 'safeParseAsync']);
const REGEXP_ESCAPE_PATTERN = /\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]/;

/** The sink kinds a call to this function makes its result safe for, or `undefined` if it is not a known cleaner. */
function sanitizerKinds(call: ts.CallExpression): ReadonlySet<SinkKind> | undefined {
    const name = calleeName(call.expression);
    if (!name) return undefined;
    const receiver = ts.isPropertyAccessExpression(call.expression) ? call.expression.expression : undefined;
    const receiverText = receiver?.getText() ?? '';

    if (NUMERIC_CONVERTERS.has(name) || (receiverText === 'Math') || (receiverText === 'Number' && /^parse/.test(name))) return EVERYTHING;
    if (SCHEMA_METHODS.has(name) && receiver && SCHEMA_RECEIVER.test(receiverText)) return EVERYTHING;
    if (PATH_SANITIZERS.has(name)) return new Set<SinkKind>(['path', 'ssrf', 'redirect']);
    if (SQL_ESCAPERS.has(name) && receiver) return new Set<SinkKind>(['sql']);
    if (SHELL_ESCAPERS.has(name)) return new Set<SinkKind>(['command']);
    if (REGEXP_ESCAPERS.has(name)) return new Set<SinkKind>(['regexp']);
    // value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (name === 'replace' && call.arguments[0] && ts.isRegularExpressionLiteral(call.arguments[0]) && REGEXP_ESCAPE_PATTERN.test(call.arguments[0].text)) return new Set<SinkKind>(['regexp']);
    return undefined;
}

/** Methods whose result still carries what the receiver carried. */
const PASSTHROUGH_METHODS = new Set([
    'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'slice', 'substring', 'substr', 'split', 'concat', 'replace', 'replaceAll', 'padStart', 'padEnd',
    'normalize', 'toString', 'at', 'charAt', 'repeat', 'join', 'get', 'getAll', 'map', 'filter', 'find', 'flat', 'flatMap', 'pop', 'shift', 'reverse', 'toJSON', 'valueOf'
]);
/** Functions that return (a transformation of) their arguments. */
const PASSTHROUGH_FUNCTIONS = new Set(['String', 'decodeURIComponent', 'decodeURI', 'atob', 'btoa', 'structuredClone']);
const PASSTHROUGH_STATICS = new Set(['join', 'resolve', 'normalize', 'format', 'values', 'entries', 'keys', 'assign', 'fromEntries', 'from', 'parse', 'concat']);

// ---- validation guards ---------------------------------------------------------------------------------------

interface Validated {
    symbol: ts.Symbol;
    kinds: ReadonlySet<SinkKind>;
}

const EXIT_CALLS = new Set(['exit', 'abort']);

function alwaysExits(statement: ts.Statement | undefined): boolean {
    if (!statement) return false;
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || ts.isContinueStatement(statement) || ts.isBreakStatement(statement)) return true;
    if (ts.isBlock(statement)) return statement.statements.length > 0 && alwaysExits(statement.statements[statement.statements.length - 1]);
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) return EXIT_CALLS.has(calleeName(statement.expression.expression) ?? '');
    if (ts.isIfStatement(statement)) return alwaysExits(statement.thenStatement) && alwaysExits(statement.elseStatement);
    return false;
}

// ---- sinks ---------------------------------------------------------------------------------------------------

interface SinkRule {
    ruleId: string;
    severity: Severity;
    title: string;
    description: string;
    suggestion: string;
}

const SINKS: Record<SinkKind, SinkRule> = {
    command: { ruleId: 'SEC003', severity: 'HIGH', title: 'Request data reaches command execution', description: 'Request-controlled data is used to build a shell command, so an attacker can run commands on the server.', suggestion: 'Use execFile/spawn with an argument array and validate the input against an allowlist.' },
    code: { ruleId: 'SEC002', severity: 'HIGH', title: 'Request data reaches code evaluation', description: 'Request-controlled data is evaluated as code.', suggestion: 'Never evaluate input as code; parse it as data (JSON.parse) instead.' },
    path: { ruleId: 'SEC009', severity: 'HIGH', title: 'Request data reaches a filesystem path', description: 'Request-controlled data is used as a file path without being confined to an allowed directory.', suggestion: 'Reduce the input with path.basename, or resolve it against an allowed root and check that the result stays inside it.' },
    sql: { ruleId: 'SEC008', severity: 'HIGH', title: 'Request data reaches a SQL query', description: 'Request-controlled data becomes part of the SQL text instead of a bound parameter.', suggestion: 'Use parameterized queries and keep user input out of SQL syntax.' },
    ssrf: { ruleId: 'SEC013', severity: 'HIGH', title: 'Server-side request forgery', description: 'Request-controlled data decides which URL the server fetches, so an attacker can reach internal services.', suggestion: 'Fetch only URLs built from a fixed base, or check the host against an allowlist before requesting.' },
    redirect: { ruleId: 'SEC012', severity: 'MEDIUM', title: 'Open redirect', description: 'Request-controlled data decides where the user is redirected, which can send them to an attacker\'s site.', suggestion: 'Redirect only to relative paths you build, or check the target against an allowlist of hosts.' },
    regexp: { ruleId: 'SEC014', severity: 'MEDIUM', title: 'Regular expression built from request data', description: 'Request-controlled data becomes a regular expression, which can match unintended input or cause catastrophic backtracking (ReDoS).', suggestion: 'Escape the input (escapeRegExp) or match with a plain string comparison.' },
    pollution: { ruleId: 'SEC011', severity: 'MEDIUM', title: 'Prototype pollution', description: 'Request-controlled keys or objects are written into an object without blocking "__proto__", which can alter every object in the process.', suggestion: 'Reject "__proto__", "constructor" and "prototype" keys, or build the target with Object.create(null) or a Map.' }
};

const FS_RECEIVERS = new Set(['fs', 'fsp', 'fsPromises', 'promises', 'fs.promises', 'fse', 'fsExtra']);
const FS_EXTRA_FUNCTIONS = new Set(['readdir', 'readdirSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'mkdir', 'mkdirSync', 'copyFile', 'copyFileSync', 'rename', 'renameSync', 'lstat', 'lstatSync', 'truncate', 'chmod', 'cp', 'cpSync', 'opendir', 'readlink']);
const RESPONSE_NAMES = new Set(['res', 'reply', 'response']);
const REDIRECT_RECEIVERS = new Set(['res', 'reply', 'response', 'c', 'ctx', 'context', 'NextResponse', 'Response']);
const HTTP_CLIENT_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'request', 'fetch']);
const HTTP_CLIENTS = new Set(['axios', 'got', 'ky', 'needle', 'superagent', 'undici', 'http', 'https', 'fetch']);
const VM_FUNCTIONS = new Set(['runInNewContext', 'runInThisContext', 'runInContext', 'compileFunction']);
const MERGE_FUNCTIONS = new Set(['merge', 'mergeWith', 'defaultsDeep', 'deepmerge', 'deepMerge', 'extend']);
const PATH_SETTERS = new Set(['set', 'setWith', 'zipObjectDeep']);
const MERGE_MODULES = /^(?:lodash(?:-es)?|lodash\.(?:merge|mergewith|defaultsdeep|set|setwith)|deepmerge|merge-deep|deep-extend|defaults-deep|mixin-deep)(?:\/|$)/;

interface SinkMatch {
    kind: SinkKind;
    args: ts.Expression[];
    label: string;
}

/** Whether a template or concatenation fixes the host or path prefix, so the tainted part cannot choose the destination. */
function prefixPinsDestination(prefix: string): boolean {
    return /^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i.test(prefix) || /^\/[^/\\]/.test(prefix);
}

function isStringLiteralLike(expression: ts.Expression | undefined): boolean {
    return !!expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression));
}

// ---- the analysis --------------------------------------------------------------------------------------------

type Env = Map<ts.Symbol, Taint>;

interface FileInfo {
    sourceFile: ts.SourceFile;
    relativePath: string;
    importedModules: Set<string>;
    mergeLibrary: boolean;
    guardsPrototype: boolean;
}

class TaintAnalysis {
    private readonly checker: ts.TypeChecker;
    private readonly summaries = new Map<ts.Node, Summary>();
    private readonly fileInfo = new Map<ts.SourceFile, FileInfo>();

    constructor(private readonly context: RuleContext) {
        this.checker = context.program.getTypeChecker();
    }

    private info(sourceFile: ts.SourceFile): FileInfo {
        let info = this.fileInfo.get(sourceFile);
        if (!info) {
            const imports = this.context.moduleGraph.importsByFile.get(sourceFile.fileName) ?? [];
            info = {
                sourceFile,
                relativePath: path.relative(this.context.projectRoot, sourceFile.fileName).replace(/\\/g, '/'),
                importedModules: new Set(imports.map((item) => item.specifier)),
                mergeLibrary: imports.some((item) => MERGE_MODULES.test(item.specifier)),
                guardsPrototype: /__proto__|hasOwnProperty|Object\.hasOwn\b|Object\.create\(null\)/.test(sourceFile.text)
            };
            this.fileInfo.set(sourceFile, info);
        }
        return info;
    }

    /** Findings for one source file: every flow that starts at a request input in this file. */
    analyzeFile(sourceFile: ts.SourceFile): { hits: Hit[]; cleared: Array<{ kind: SinkKind; node: ts.Node }> } {
        const run = new FunctionRun(this, sourceFile, undefined, new Map());
        run.walk(sourceFile);
        return { hits: run.sourceHits, cleared: run.clearedSinks };
    }

    // Used by FunctionRun.
    get typeChecker(): ts.TypeChecker { return this.checker; }
    infoFor(node: ts.Node): FileInfo { return this.info(node.getSourceFile()); }
    relative(node: ts.Node): { file: string; line: number } {
        const sourceFile = node.getSourceFile();
        return { file: this.info(sourceFile).relativePath, line: lineAndColumn(sourceFile, node.getStart(sourceFile)).line };
    }

    /** The project function a call resolves to, if any (through imports, methods and const-assigned arrows). */
    resolveFunction(call: ts.CallExpression): ts.FunctionLikeDeclaration | undefined {
        const target = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
        let symbol: ts.Symbol | undefined;
        try { symbol = this.checker.getSymbolAtLocation(target); } catch { return undefined; }
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
            try { symbol = this.checker.getAliasedSymbol(symbol); } catch { return undefined; }
        }
        for (const declaration of symbol?.declarations ?? []) {
            if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) { if (declaration.body) return declaration; }
            if (ts.isVariableDeclaration(declaration) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) return declaration.initializer;
        }
        return undefined;
    }

    summaryOf(fn: ts.FunctionLikeDeclaration): Summary {
        const known = this.summaries.get(fn);
        if (known) return known;
        // Recursion: while a function is being summarized, calls back into it see an empty summary.
        const summary: Summary = { paramHits: new Map() };
        this.summaries.set(fn, summary);
        const run = new FunctionRun(this, fn.getSourceFile(), fn, new Map());
        run.walk(fn);
        summary.paramHits = run.paramHits;
        summary.returns = run.returns;
        return summary;
    }
}

class FunctionRun {
    readonly sourceHits: Hit[] = [];
    /** Sinks reached only by data that was explicitly cleaned for them: a pattern-based finding there is a false alarm. */
    readonly clearedSinks: Array<{ kind: SinkKind; node: ts.Node }> = [];
    readonly paramHits = new Map<number, Hit[]>();
    returns: Taint | undefined;
    private readonly seen = new Set<string>();
    private readonly declaredIn = new Map<ts.Symbol, ts.Node>();

    constructor(
        private readonly analysis: TaintAnalysis,
        private readonly sourceFile: ts.SourceFile,
        private readonly root: ts.Node | undefined,
        private env: Env,
        private readonly parent?: FunctionRun
    ) {
        if (root && ts.isFunctionLike(root)) this.seedParameters(root as ts.SignatureDeclaration);
    }

    private get checker(): ts.TypeChecker { return this.analysis.typeChecker; }
    private get info(): FileInfo { return this.analysis.infoFor(this.sourceFile); }

    private symbolOf(node: ts.Node): ts.Symbol | undefined {
        try { return this.checker.getSymbolAtLocation(node); } catch { return undefined; }
    }

    private seedParameters(fn: ts.SignatureDeclaration): void {
        fn.parameters.forEach((parameter, index) => {
            const decorators = ts.canHaveDecorators(parameter) ? ts.getDecorators(parameter) ?? [] : [];
            const decorated = decorators.map((decorator) => ts.isCallExpression(decorator.expression) ? calleeName(decorator.expression.expression) : calleeName(decorator.expression)).find((name) => name && DECORATED_SOURCES.has(name));
            const names: string[] = [];
            this.bindingNames(parameter.name, names);
            const label = decorated ? `@${decorated}() ${names[0] ?? 'parameter'}` : undefined;
            const taint: Taint = {
                origins: [{ type: 'param', index }, ...(label ? [{ type: 'source', label, local: false } as Origin] : [])],
                clean: NO_KINDS, leading: true, trace: [label ?? names[0] ?? `parameter ${index}`]
            };
            // `req`/`request` themselves are not data: only their properties are (see sourceOf).
            if (!label && ts.isIdentifier(parameter.name) && REQUEST_NAMES.has(parameter.name.text)) return;
            this.bind(parameter.name, taint, parameter);
        });
    }

    private bindingNames(name: ts.BindingName, into: string[]): void {
        if (ts.isIdentifier(name)) into.push(name.text);
        else for (const element of name.elements) if (ts.isBindingElement(element)) this.bindingNames(element.name, into);
    }

    // ---- environment -----------------------------------------------------------------------------------------

    private bind(name: ts.BindingName, taint: Taint | undefined, scope: ts.Node): void {
        if (ts.isIdentifier(name)) {
            const symbol = this.symbolOf(name);
            if (!symbol) return;
            if (taint) this.env.set(symbol, extend(taint, name.text));
            else this.env.delete(symbol);
            this.declaredIn.set(symbol, this.statementListOf(scope));
            return;
        }
        for (const element of name.elements) if (ts.isBindingElement(element)) this.bind(element.name, taint, scope);
    }

    private statementListOf(node: ts.Node): ts.Node {
        return ts.findAncestor(node, (candidate) => ts.isBlock(candidate) || ts.isSourceFile(candidate) || ts.isCaseClause(candidate) || ts.isDefaultClause(candidate)) ?? this.sourceFile;
    }

    private withClean<T>(validated: Validated[], action: () => T): T {
        const saved = validated.map(({ symbol }) => [symbol, this.env.get(symbol)] as const);
        for (const { symbol, kinds } of validated) {
            const current = this.env.get(symbol);
            if (current) this.env.set(symbol, makeClean(current, kinds));
        }
        try {
            return action();
        } finally {
            for (const [symbol, previous] of saved) {
                if (previous) this.env.set(symbol, previous);
                else this.env.delete(symbol);
            }
        }
    }

    // ---- expression taint ------------------------------------------------------------------------------------

    taintOf(expression: ts.Expression | undefined): Taint | undefined {
        if (!expression) return undefined;
        if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isAwaitExpression(expression) || ts.isSpreadElement(expression)) {
            return this.taintOf(expression.expression);
        }
        const source = sourceOf(expression);
        if (source) return source;

        if (ts.isIdentifier(expression)) {
            const symbol = this.symbolOf(expression);
            return symbol ? this.env.get(symbol) ?? this.parent?.lookup(symbol) : undefined;
        }
        if (ts.isPropertyAccessExpression(expression)) {
            if (['length', 'size', 'byteLength'].includes(expression.name.text)) return undefined;
            return this.taintOf(expression.expression);
        }
        if (ts.isElementAccessExpression(expression)) return this.taintOf(expression.expression);
        if (ts.isTemplateExpression(expression)) {
            const parts = expression.templateSpans.map((span) => this.taintOf(span.expression));
            const combined = union(...parts);
            if (!combined) return undefined;
            const pinned = expression.head.text.length > 0 && prefixPinsDestination(expression.head.text);
            const leading = !pinned && (expression.head.text.length === 0 ? !!parts[0] : false);
            const lastTainted = parts.map((part) => !!part).lastIndexOf(true);
            const suffixed = expression.templateSpans.slice(lastTainted).some((span) => span.literal.text.length > 0);
            return { ...combined, leading, suffixed };
        }
        if (ts.isBinaryExpression(expression)) {
            const operator = expression.operatorToken.kind;
            if (operator === ts.SyntaxKind.PlusToken) {
                const left = this.taintOf(expression.left);
                const right = this.taintOf(expression.right);
                const combined = union(left, right);
                if (!combined) return undefined;
                const prefix = ts.isStringLiteral(expression.left) ? expression.left.text : '';
                const suffixed = !!left && !right && (ts.isStringLiteral(expression.right) || ts.isNoSubstitutionTemplateLiteral(expression.right)) && expression.right.text.length > 0;
                return { ...combined, leading: !prefixPinsDestination(prefix) && (prefix.length === 0 ? !!left : false), suffixed: suffixed || (!!right && !left ? false : !!combined.suffixed && !!left && !right) };
            }
            if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.CommaToken) {
                return union(this.taintOf(expression.left), this.taintOf(expression.right));
            }
            return undefined;
        }
        if (ts.isConditionalExpression(expression)) {
            // `ALLOWED.includes(f(x)) ? f(x) : 'default'`: the checked expression and the one returned are the same text.
            const checked = this.allowlistSubject(expression.condition);
            const allowed = checked !== undefined && checked === expression.whenTrue.getText();
            const whenTrue = allowed ? makeCleanOrUndefined(this.taintOf(expression.whenTrue)) : this.withClean(this.validatedBy(expression.condition, true), () => this.taintOf(expression.whenTrue));
            const whenFalse = this.withClean(this.validatedBy(expression.condition, false), () => this.taintOf(expression.whenFalse));
            return union(whenTrue, whenFalse);
        }
        if (ts.isObjectLiteralExpression(expression)) {
            return union(...expression.properties.map((property) => ts.isPropertyAssignment(property) ? this.taintOf(property.initializer) : ts.isShorthandPropertyAssignment(property) ? this.shorthandTaint(property) : ts.isSpreadAssignment(property) ? this.taintOf(property.expression) : undefined));
        }
        if (ts.isArrayLiteralExpression(expression)) return union(...expression.elements.map((element) => this.taintOf(element)));
        if (ts.isNewExpression(expression)) {
            if (ts.isIdentifier(expression.expression) && expression.expression.text === 'URL' && expression.arguments?.[0]) return this.taintOf(expression.arguments[0]);
            return undefined;
        }
        if (ts.isCallExpression(expression)) return this.taintOfCall(expression);
        return undefined;
    }

    private shorthandTaint(property: ts.ShorthandPropertyAssignment): Taint | undefined {
        const symbol = this.checker.getShorthandAssignmentValueSymbol(property);
        return symbol ? this.lookup(symbol) : undefined;
    }

    lookup(symbol: ts.Symbol): Taint | undefined {
        return this.env.get(symbol) ?? this.parent?.lookup(symbol);
    }

    private taintOfCall(call: ts.CallExpression): Taint | undefined {
        const cleaned = sanitizerKinds(call);
        if (cleaned) {
            const inputs = union(this.taintOf(ts.isPropertyAccessExpression(call.expression) ? call.expression.expression : undefined), ...call.arguments.map((argument) => this.taintOf(argument)));
            return inputs ? makeClean(inputs, cleaned) : undefined;
        }

        // A project function: what it returns, given what was passed in.
        const target = this.analysis.resolveFunction(call);
        if (target) {
            const summary = this.analysis.summaryOf(target);
            if (!summary.returns) return undefined;
            const substituted: Array<Taint | undefined> = [];
            for (const origin of summary.returns.origins) {
                if (origin.type === 'source') substituted.push({ ...summary.returns, origins: [origin] });
                else substituted.push(this.taintOf(call.arguments[origin.index]));
            }
            const result = union(...substituted);
            return result ? { ...result, clean: new Set([...result.clean].filter((kind) => summary.returns!.clean.has(kind) || result.clean.has(kind))) } : undefined;
        }

        const name = calleeName(call.expression);
        if (!name) return undefined;
        if (ts.isPropertyAccessExpression(call.expression)) {
            const receiver = this.taintOf(call.expression.expression);
            if (receiver && PASSTHROUGH_METHODS.has(name)) return union(receiver, ...(name === 'concat' || name === 'replace' || name === 'replaceAll' ? call.arguments.map((argument) => this.taintOf(argument)) : []));
            const receiverName = identifierText(call.expression.expression) ?? call.expression.expression.getText();
            if (PASSTHROUGH_STATICS.has(name) && /^(?:path|posix|win32|url|Object|Array|JSON|querystring|qs|Buffer|path\.posix|path\.win32)$/.test(receiverName)) {
                return union(...call.arguments.map((argument) => this.taintOf(argument)));
            }
            return undefined;
        }
        if (PASSTHROUGH_FUNCTIONS.has(name)) return union(...call.arguments.map((argument) => this.taintOf(argument)));
        return undefined;
    }

    // ---- guards ----------------------------------------------------------------------------------------------

    /** Variables known to be validated when `condition` evaluates to `outcome`. */
    private validatedBy(condition: ts.Expression, outcome: boolean): Validated[] {
        if (ts.isParenthesizedExpression(condition)) return this.validatedBy(condition.expression, outcome);
        if (ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken) return this.validatedBy(condition.operand, !outcome);

        if (ts.isBinaryExpression(condition)) {
            const operator = condition.operatorToken.kind;
            if (operator === ts.SyntaxKind.AmpersandAmpersandToken && outcome) {
                const both = [...this.validatedBy(condition.left, true), ...this.validatedBy(condition.right, true)];
                // `x.startsWith('/') && !x.startsWith('//')` keeps a redirect on this site.
                const relative = this.relativePathCheck(condition);
                return relative ? [...both, relative] : both;
            }
            if (operator === ts.SyntaxKind.BarBarToken && !outcome) return [...this.validatedBy(condition.left, false), ...this.validatedBy(condition.right, false)];
            if ((operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsToken) && outcome) return this.equalityGuard(condition);
            if ((operator === ts.SyntaxKind.ExclamationEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken) && !outcome) return this.equalityGuard(condition);
            return [];
        }

        if (ts.isCallExpression(condition)) return outcome ? this.callGuard(condition) : this.rejectingGuard(condition);
        return [];
    }

    /**
     * Checks that confine a path: `x.startsWith(root)` is true, or `x.includes('..')` / `x.includes('/')` /
     * `path.relative(root, x).startsWith('..')` is false. They clear only filesystem sinks.
     */
    private rejectingGuard(call: ts.CallExpression): Validated[] {
        if (!ts.isPropertyAccessExpression(call.expression)) return [];
        const method = call.expression.name.text;
        const argument = call.arguments[0];
        const literal = argument && ts.isStringLiteral(argument) ? argument.text : undefined;
        const paths = new Set<SinkKind>(['path']);

        // path.relative(root, x).startsWith('..') is false: x stays under root.
        if (method === 'startsWith' && literal === '..' && ts.isCallExpression(call.expression.expression) && calleeName(call.expression.expression.expression) === 'relative') {
            const subject = call.expression.expression.arguments[1] ? this.identifierSymbol(call.expression.expression.arguments[1]) : undefined;
            return subject ? [{ symbol: subject, kinds: paths }] : [];
        }
        // x.includes('..') / x.includes('/') / x.includes('\\') is false: no way to leave the directory.
        if (method === 'includes' && literal !== undefined && ['..', '/', '\\'].includes(literal)) {
            const subject = this.identifierSymbol(call.expression.expression);
            return subject ? [{ symbol: subject, kinds: paths }] : [];
        }
        return [];
    }

    /** The text of the expression an allowlist check (`LIST.includes(expr)`, `SET.has(expr)`) is applied to. */
    private allowlistSubject(condition: ts.Expression): string | undefined {
        let current = condition;
        while (ts.isParenthesizedExpression(current)) current = current.expression;
        if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) && ['includes', 'has'].includes(current.expression.name.text) && current.arguments[0]) {
            return current.arguments[0].getText();
        }
        return undefined;
    }

    private identifierSymbol(expression: ts.Expression): ts.Symbol | undefined {
        let current = expression;
        while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
        return ts.isIdentifier(current) ? this.symbolOf(current) : undefined;
    }

    private equalityGuard(condition: ts.BinaryExpression): Validated[] {
        const sides = [condition.left, condition.right];
        for (const [index, side] of sides.entries()) {
            const other = sides[1 - index];
            const symbol = this.identifierSymbol(side);
            // x === 'literal'
            if (symbol && (isStringLiteralLike(other) || ts.isNumericLiteral(other))) return [{ symbol, kinds: EVERYTHING }];
            // typeof x === 'number'
            if (ts.isTypeOfExpression(side) && ts.isStringLiteral(other) && ['number', 'boolean', 'bigint'].includes(other.text)) {
                const typed = this.identifierSymbol(side.expression);
                if (typed) return [{ symbol: typed, kinds: EVERYTHING }];
            }
            // new URL(x).origin === 'https://trusted.example'
            if (ts.isPropertyAccessExpression(side) && ['origin', 'host', 'hostname'].includes(side.name.text) && ts.isNewExpression(side.expression) && side.expression.arguments?.[0]) {
                const urlSymbol = this.identifierSymbol(side.expression.arguments[0]);
                if (urlSymbol) return [{ symbol: urlSymbol, kinds: new Set<SinkKind>(['ssrf', 'redirect']) }];
            }
        }
        return [];
    }

    private relativePathCheck(condition: ts.BinaryExpression): Validated | undefined {
        const startsWith = (expression: ts.Expression, prefix: string, negated: boolean): ts.Symbol | undefined => {
            let current = expression;
            if (negated) {
                if (!ts.isPrefixUnaryExpression(current) || current.operator !== ts.SyntaxKind.ExclamationToken) return undefined;
                current = current.operand;
            }
            if (ts.isParenthesizedExpression(current)) current = current.expression;
            if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression) || current.expression.name.text !== 'startsWith') return undefined;
            const argument = current.arguments[0];
            return argument && ts.isStringLiteral(argument) && argument.text === prefix ? this.identifierSymbol(current.expression.expression) : undefined;
        };
        for (const [first, second] of [[condition.left, condition.right], [condition.right, condition.left]]) {
            const single = startsWith(first, '/', false);
            const double = startsWith(second, '//', true);
            if (single && single === double) return { symbol: single, kinds: new Set<SinkKind>(['redirect']) };
        }
        return undefined;
    }

    private callGuard(call: ts.CallExpression): Validated[] {
        const name = calleeName(call.expression);
        if (!name) return [];
        const receiver = ts.isPropertyAccessExpression(call.expression) ? call.expression.expression : undefined;
        const argument = call.arguments[0];

        // resolved.startsWith(root): the path was resolved and then confined to a directory (a redirect target is not).
        if (name === 'startsWith' && receiver && argument && !isStringLiteralLike(argument)) {
            const confined = this.identifierSymbol(receiver);
            return confined ? [{ symbol: confined, kinds: new Set<SinkKind>(['path']) }] : [];
        }

        const subject = argument ? this.identifierSymbol(argument) : undefined;
        if (!subject) return [];
        const receiverSymbol = receiver ? this.identifierSymbol(receiver) : undefined;
        if (receiverSymbol === subject) return [];

        // ALLOWED.includes(x), allowedHosts.has(x), /^[\w-]+$/.test(x)
        if ((name === 'includes' || name === 'has' || name === 'test') && receiver) return [{ symbol: subject, kinds: EVERYTHING }];
        if (['isInteger', 'isFinite', 'isSafeInteger'].includes(name) && receiver?.getText() === 'Number') return [{ symbol: subject, kinds: EVERYTHING }];
        // validator.isUUID(x), isValidId(x), assertSafe(x)
        if (/^(?:is|validate|assert|check)[A-Z]/.test(name)) return [{ symbol: subject, kinds: EVERYTHING }];
        return [];
    }

    // ---- statements and sinks --------------------------------------------------------------------------------

    walk(root: ts.Node): void {
        const body = ts.isFunctionLike(root) ? (root as ts.FunctionLikeDeclaration).body : root;
        if (!body) return;
        if (ts.isFunctionLike(root) && !ts.isBlock(body)) {
            // Concise arrow body: the expression is the return value.
            this.visit(body);
            this.returns = union(this.returns, this.taintOf(body as ts.Expression));
            return;
        }
        this.visit(body);
    }

    private visit = (node: ts.Node): void => {
        if (ts.isFunctionLike(node) && node !== this.root && !ts.isSourceFile(node)) {
            this.visitNestedFunction(node as ts.FunctionLikeDeclaration);
            return;
        }

        if (ts.isIfStatement(node)) {
            this.visit(node.expression);
            const whenTrue = this.validatedBy(node.expression, true);
            const whenFalse = this.validatedBy(node.expression, false);
            this.withClean(whenTrue, () => this.visit(node.thenStatement));
            if (node.elseStatement) this.withClean(whenFalse, () => this.visit(node.elseStatement!));
            // `if (!valid(x)) return;` leaves the code below with x validated.
            const thenExits = alwaysExits(node.thenStatement);
            const elseExits = alwaysExits(node.elseStatement);
            const after = thenExits && !elseExits ? whenFalse : elseExits && !thenExits ? whenTrue : [];
            for (const { symbol, kinds } of after) {
                const current = this.env.get(symbol);
                if (current) this.env.set(symbol, makeClean(current, kinds));
            }
            return;
        }

        ts.forEachChild(node, this.visit);

        if (ts.isVariableDeclaration(node)) {
            this.bind(node.name, this.taintOf(node.initializer), node);
        } else if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
            this.handleAssignment(node);
        } else if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
            if (ts.isVariableDeclarationList(node.initializer)) this.bind(node.initializer.declarations[0].name, this.taintOf(node.expression), node);
        } else if (ts.isReturnStatement(node)) {
            this.returns = union(this.returns, this.taintOf(node.expression));
        } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            this.handleCall(node);
        }
    };

    private visitNestedFunction(fn: ts.FunctionLikeDeclaration): void {
        // A closure sees the variables of the function around it; its own findings count as this function's.
        const inner = new FunctionRun(this.analysis, this.sourceFile, fn, new Map(), this);
        inner.walk(fn);
        for (const hit of inner.sourceHits) this.record(hit);
        this.clearedSinks.push(...inner.clearedSinks);
    }

    private handleAssignment(node: ts.BinaryExpression): void {
        const operator = node.operatorToken.kind;
        let value = this.taintOf(node.right);
        if (operator !== ts.SyntaxKind.EqualsToken) value = union(this.taintOf(node.left), value);

        if (ts.isIdentifier(node.left)) {
            const symbol = this.symbolOf(node.left);
            if (!symbol) return;
            if (value) this.env.set(symbol, extend(value, node.left.text));
            // A clean value replaces the taint only when assigned in the block that declared the variable; in a branch the old value may survive.
            else if (this.declaredIn.get(symbol) === this.statementListOf(node)) this.env.delete(symbol);
            return;
        }

        if (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) {
            // `config.name = tainted` makes `config` carry it.
            const base = this.identifierSymbol(this.rootOf(node.left));
            if (base && value) this.env.set(base, union(this.env.get(base), value)!);
            if (ts.isElementAccessExpression(node.left)) this.checkPollution(node, node.left);
        }
    }

    private rootOf(expression: ts.Expression): ts.Expression {
        let current = expression;
        while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = current.expression;
        return current;
    }

    /** `target[a][b] = value` where a key comes from the request: with a = "__proto__" this writes to Object.prototype. */
    private checkPollution(assignment: ts.BinaryExpression, left: ts.ElementAccessExpression): void {
        if (this.info.guardsPrototype) return;
        const inner = left.expression;
        if (!ts.isElementAccessExpression(inner)) return;
        const keys = [this.taintOf(left.argumentExpression), this.taintOf(inner.argumentExpression)];
        const key = union(...keys);
        if (key && !key.clean.has('pollution')) this.emit({ kind: 'pollution', node: assignment, label: `${left.getText().slice(0, 60)} = ...`, taint: key });
    }

    private handleCall(node: ts.CallExpression | ts.NewExpression): void {
        for (const match of this.sinksOf(node)) {
            for (const argument of match.args) {
                const taint = this.taintOf(argument);
                if (taint && taint.clean.has(match.kind)) this.clearedSinks.push({ kind: match.kind, node });
                if (!taint || taint.clean.has(match.kind)) continue;
                // Only the part that comes first can choose a host; a tainted path segment under a fixed base is not SSRF or an open redirect.
                if ((match.kind === 'ssrf' || match.kind === 'redirect') && !taint.leading) continue;
                this.emit({ kind: match.kind, node, label: match.label, taint });
            }
        }

        if (!ts.isCallExpression(node)) return;
        const target = this.analysis.resolveFunction(node);
        if (!target) return;
        const summary = this.analysis.summaryOf(target);
        const callee = calleeName(node.expression) ?? 'function';
        for (const [index, hits] of summary.paramHits) {
            const taint = this.taintOf(node.arguments[index]);
            if (!taint) continue;
            for (const hit of hits) {
                if (taint.clean.has(hit.kind) || ((hit.kind === 'ssrf' || hit.kind === 'redirect') && !taint.leading)) continue;
                const where = this.analysis.relative(hit.node);
                this.emit({ kind: hit.kind, node, label: `${callee}()`, taint, via: hit.via ?? { callee: hit.label, ...where } });
            }
        }
    }

    private emit(hit: Hit): void {
        const key = `${hit.node.pos}:${hit.node.end}:${hit.kind}:${hit.via?.line ?? 0}`;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        this.record(hit);
    }

    /** Sends a hit to the findings if its data comes from a request input, and to the summary for each parameter it comes from. */
    private record(hit: Hit): void {
        if (hit.taint.origins.some((origin) => origin.type === 'source')) this.sourceHits.push(hit);
        for (const origin of hit.taint.origins) {
            if (origin.type !== 'param') continue;
            const hits = this.paramHits.get(origin.index) ?? [];
            if (!hits.includes(hit)) hits.push(hit);
            this.paramHits.set(origin.index, hits);
        }
    }

    // ---- sink table ------------------------------------------------------------------------------------------

    private sinksOf(node: ts.CallExpression | ts.NewExpression): SinkMatch[] {
        const matches: SinkMatch[] = [];
        const args = [...(node.arguments ?? [])];
        const callee = node.expression;
        const name = calleeName(callee);
        const receiverText = ts.isPropertyAccessExpression(callee) ? callee.expression.getText() : '';
        const receiverName = ts.isPropertyAccessExpression(callee) ? identifierText(callee.expression) : undefined;
        const add = (kind: SinkKind, sinkArgs: Array<ts.Expression | undefined>, label = name ?? kind): void => {
            const present = sinkArgs.filter((argument): argument is ts.Expression => !!argument);
            if (present.length > 0) matches.push({ kind, args: present, label });
        };

        if (ts.isNewExpression(node)) {
            if (identifierText(callee) === 'RegExp') add('regexp', [args[0]], 'new RegExp');
            if (identifierText(callee) === 'Function') add('code', args, 'new Function');
            return matches;
        }

        if (!name) return matches;
        if (name === 'RegExp' && ts.isIdentifier(callee)) add('regexp', [args[0]], 'RegExp');
        if (name === 'eval' && ts.isIdentifier(callee)) add('code', [args[0]], 'eval');
        if (name === 'Function' && ts.isIdentifier(callee)) add('code', args, 'Function');
        if (VM_FUNCTIONS.has(name)) add('code', [args[0]], name);

        // Command execution: resolved through the type checker, so db.exec() and regex.exec() are not mistaken for child_process.
        const importedName = importedCalleeName(this.checker, callee) ?? name;
        // A method call counts only on a child_process import: the untyped fallback of the pattern check would take `db.exec()` for it.
        const execCallee = ts.isPropertyAccessExpression(callee) ? this.isChildProcessReceiver(callee.expression) : mayBeShellExecution(this.checker, node, this.info.importedModules);
        if (EXEC_FUNCTION_NAMES.has(importedName) && execCallee) add('command', [args[0]], importedName);
        if (SHELL_FUNCTION_NAMES.has(name) && args.some((argument) => ts.isObjectLiteralExpression(argument) && argument.properties.some((property) => ts.isPropertyAssignment(property) && property.name.getText() === 'shell' && property.initializer.kind === ts.SyntaxKind.TrueKeyword))) {
            add('command', [args[0], ...(args[1] && ts.isArrayLiteralExpression(args[1]) ? args[1].elements : [])], name);
        }

        // Filesystem: fs.*, fs/promises and fs-extra, or the same functions imported by name.
        const fsFunction = FILE_FUNCTION_NAMES.has(name) || FS_EXTRA_FUNCTIONS.has(name);
        if (fsFunction && (FS_RECEIVERS.has(receiverText) || (ts.isIdentifier(callee) && this.isImportedFrom(callee, /^(?:node:)?fs(?:\/promises)?$|^fs-extra$/)))) {
            add('path', name === 'rename' || name === 'renameSync' || name === 'copyFile' || name === 'copyFileSync' || name === 'cp' || name === 'cpSync' ? [args[0], args[1]] : [args[0]], `${receiverName ?? 'fs'}.${name}`);
        }
        if ((name === 'sendFile' || name === 'download' || name === 'sendfile') && receiverName && RESPONSE_NAMES.has(receiverName)) {
            const options = args[1];
            const rooted = options && ts.isObjectLiteralExpression(options) && options.properties.some((property) => ts.isPropertyAssignment(property) && property.name.getText() === 'root');
            if (!rooted) add('path', [args[0]], `${receiverName}.${name}`);
        }

        // SQL: the dynamic part must reach the query text, and `req.query(...)` style accessors are not queries.
        if (SQL_FUNCTION_NAMES.has(name) && ts.isPropertyAccessExpression(callee) && !/(?:^|\.)(?:req|request)$/.test(receiverText) && args[0] && !isStringLiteralLike(args[0])) {
            add('sql', [args[0]], `${receiverText || 'db'}.${name}`);
        }

        // SSRF
        const httpClient = (ts.isIdentifier(callee) && (callee.text === 'fetch' || callee.text === 'axios' || callee.text === 'got' || callee.text === 'ky' || callee.text === 'needle'))
            || (receiverName && HTTP_CLIENTS.has(receiverName) && HTTP_CLIENT_METHODS.has(name));
        if (httpClient) {
            const first = args[0];
            const url = first && ts.isObjectLiteralExpression(first)
                ? first.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && property.name.getText() === 'url')?.initializer
                : first;
            add('ssrf', [url], receiverName ? `${receiverName}.${name}` : name);
        }

        // Open redirect
        if (name === 'redirect' && ((receiverName && REDIRECT_RECEIVERS.has(receiverName)) || ts.isIdentifier(callee))) {
            const target = args[0] && ts.isNumericLiteral(args[0]) ? args[1] : args[0];
            add('redirect', [target], receiverName ? `${receiverName}.redirect` : 'redirect');
        }
        if ((name === 'setHeader' || name === 'header' || name === 'set' || name === 'location') && receiverName && RESPONSE_NAMES.has(receiverName)) {
            if (name === 'location') add('redirect', [args[0]], `${receiverName}.location`);
            else if (args[0] && ts.isStringLiteral(args[0]) && args[0].text.toLowerCase() === 'location') add('redirect', [args[1]], `${receiverName}.${name}('Location')`);
        }
        if (name === 'writeHead' && receiverName && RESPONSE_NAMES.has(receiverName) && args[1] && ts.isObjectLiteralExpression(args[1])) {
            const location = args[1].properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && /^['"]?location['"]?$/i.test(property.name.getText()));
            add('redirect', [location?.initializer], `${receiverName}.writeHead`);
        }

        // Prototype pollution through merge libraries.
        if (this.info.mergeLibrary && !this.info.guardsPrototype) {
            if (MERGE_FUNCTIONS.has(name)) add('pollution', args.slice(1), name);
            if (PATH_SETTERS.has(name)) add('pollution', [args[1]], name);
        }
        return matches;
    }

    private isChildProcessReceiver(receiver: ts.Expression): boolean {
        const symbol = ts.isIdentifier(receiver) ? this.symbolOf(receiver) : undefined;
        return (symbol?.declarations ?? []).some((declaration) => {
            const importDeclaration = ts.findAncestor(declaration, ts.isImportDeclaration);
            if (importDeclaration && ts.isStringLiteral(importDeclaration.moduleSpecifier)) return /^(?:node:)?child_process$/.test(importDeclaration.moduleSpecifier.text);
            if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isCallExpression(declaration.initializer)) {
                const required = declaration.initializer.arguments[0];
                return ts.isIdentifier(declaration.initializer.expression) && declaration.initializer.expression.text === 'require' && !!required && ts.isStringLiteral(required) && /^(?:node:)?child_process$/.test(required.text);
            }
            return false;
        });
    }

    private isImportedFrom(identifier: ts.Identifier, modulePattern: RegExp): boolean {
        const symbol = this.symbolOf(identifier);
        return (symbol?.declarations ?? []).some((declaration) => {
            const importDeclaration = ts.findAncestor(declaration, ts.isImportDeclaration);
            return !!importDeclaration && ts.isStringLiteral(importDeclaration.moduleSpecifier) && modulePattern.test(importDeclaration.moduleSpecifier.text);
        });
    }
}

// ---- reporting -----------------------------------------------------------------------------------------------

function describeFlow(hit: Hit): string {
    const source = hit.taint.origins.find((origin) => origin.type === 'source');
    const path = [...hit.taint.trace, hit.label].join(' → ');
    const via = hit.via ? ` The data is passed to ${hit.label}, which reaches ${hit.via.callee} (${hit.via.file}:${hit.via.line}).` : '';
    return `${source && source.type === 'source' ? `Data from ${source.label}` : 'Request data'} flows to ${hit.via ? hit.via.callee : hit.label}: ${path}.${via}`;
}

const SOURCE_TOKENS = /\b(?:req|request)\b|\bctx\b|\bcontext\.(?:params|query)\b|\bc\.req\b|process\.argv|@(?:Body|Query|Param|Headers|Req|Request)\b/;

export interface TaintResult {
    findings: Finding[];
    /** Pattern-based findings to retract: the data reaching these calls was cleaned for them. */
    cleared: Array<{ ruleId: string; file: string; line: number }>;
}

/** Taint-based findings, one per distinct sink reached by request-controlled data. */
export function runTaintRules(context: RuleContext): TaintResult {
    const enabled = (ruleId: string) => isRuleEnabled(context.config, ruleId);
    const analysis = new TaintAnalysis(context);
    const result: TaintResult = { findings: [], cleared: [] };

    for (const file of context.files) {
        const sourceFile = context.program.getSourceFile(file);
        // Only files that can introduce a request input start a flow; helpers in other files are reached through call summaries.
        if (!sourceFile || !SOURCE_TOKENS.test(readFileSafe(file))) continue;
        const relativePath = path.relative(context.projectRoot, file).replace(/\\/g, '/');
        const { hits, cleared } = analysis.analyzeFile(sourceFile);

        for (const { kind, node } of cleared) {
            result.cleared.push({ ruleId: SINKS[kind].ruleId, file: relativePath, line: lineAndColumn(sourceFile, node.getStart(sourceFile)).line });
        }

        for (const hit of hits) {
            const sink = SINKS[hit.kind];
            if (!enabled(sink.ruleId)) continue;
            const local = hit.taint.origins.some((origin) => origin.type === 'source' && origin.local);
            // A path with fixed text after the tainted part (`dir + name + '.yml'`) can reach fewer files, so it is less certain.
            const confined = hit.kind === 'path' && !!hit.taint.suffixed;
            const direct = !hit.via && hit.kind !== 'pollution' && hit.kind !== 'regexp' && !confined;
            const confidence: Confidence = direct && !local ? 'HIGH' : 'MEDIUM';
            const { line, column } = lineAndColumn(sourceFile, hit.node.getStart(sourceFile));
            result.findings.push(buildFinding({
                ruleId: sink.ruleId, category: 'security', severity: sink.severity, confidence, file: relativePath, line, column,
                message: sink.title, description: `${sink.description} ${describeFlow(hit)}`,
                evidence: [...hit.taint.trace, hit.label].join(' → ').slice(0, 200), suggestion: sink.suggestion, fixAvailable: false
            }));
        }
    }
    return result;
}
