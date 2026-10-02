import type { RuleDefinition } from './types';

export const rules: RuleDefinition[] = [
    // Dead code
    {
        id: 'DEAD002',
        title: 'Unused import',
        category: 'deadCode',
        severity: 'MEDIUM',
        confidence: 'CERTAIN',
        description: 'An imported binding is never referenced in the file.',
        explanation: 'Verified by the TypeScript compiler (noUnusedLocals/noUnusedParameters).',
        example: "import { unused } from './util';",
        why: 'Unused imports add noise and can hide typos in what should have been imported.',
        fixClassification: 'safe'
    },
    {
        id: 'DEAD003',
        title: 'Unused variable',
        category: 'deadCode',
        severity: 'MEDIUM',
        confidence: 'CERTAIN',
        description: 'A local variable (or destructured binding) is declared but never read.',
        explanation: 'Verified by the TypeScript compiler.',
        example: 'const result = compute(); // result is never used',
        why: 'Dead locals are maintenance noise and often indicate an incomplete refactor.',
        fixClassification: 'safe'
    },
    {
        id: 'DEAD004',
        title: 'Unused function',
        category: 'deadCode',
        severity: 'MEDIUM',
        confidence: 'CERTAIN',
        description: 'A non-exported function is declared but never called anywhere in the file.',
        explanation: 'Verified by the TypeScript compiler.',
        example: 'function helper() { /* never called */ }',
        why: 'Unused functions are dead weight and a common artifact of incomplete refactors.',
        fixClassification: 'unsafe'
    },
    {
        id: 'DEAD005',
        title: 'Unused class',
        category: 'deadCode',
        severity: 'MEDIUM',
        confidence: 'CERTAIN',
        description: 'A non-exported class is declared but never instantiated or referenced.',
        explanation: 'Verified by the TypeScript compiler.',
        example: 'class Helper { /* never used */ }',
        why: 'Unused classes increase surface area with no runtime benefit.',
        fixClassification: 'unsafe'
    },
    {
        id: 'DEAD006',
        title: 'Unused parameter',
        category: 'deadCode',
        severity: 'LOW',
        confidence: 'CERTAIN',
        description: 'A function parameter is declared but never read in the function body.',
        explanation: 'Verified by the TypeScript compiler.',
        example: 'function handler(req, res) { return res.end(); } // req unused',
        why: 'Often fine, but can indicate a forgotten argument or stale interface.',
        fixClassification: 'safe'
    },
    {
        id: 'DEAD007',
        title: 'Unused type',
        category: 'deadCode',
        severity: 'MEDIUM',
        confidence: 'CERTAIN',
        description: 'A type alias or interface is declared but never referenced.',
        explanation: 'Verified by the TypeScript compiler.',
        example: 'interface Options { } // never used',
        why: 'Unused types drift out of sync with real usage and mislead readers.',
        fixClassification: 'unsafe'
    },
    {
        id: 'DEAD009',
        title: 'Unused export',
        category: 'deadCode',
        severity: 'MEDIUM',
        confidence: 'MEDIUM',
        description: 'An exported symbol is not imported by any other file in the project.',
        explanation: 'Computed from the internal import/export graph; cannot see consumers outside this repository.',
        example: 'export function unusedHelper() { }',
        why: 'Unused exports often mean the export can be made private or removed entirely.',
        fixClassification: 'unsafe'
    },
    {
        id: 'DEAD010',
        title: 'Unused file',
        category: 'deadCode',
        severity: 'MEDIUM',
        confidence: 'MEDIUM',
        description: 'A file is never imported by any other file and is not a configured entry point.',
        explanation: 'Computed from the internal import graph plus package.json main/bin/scripts.',
        example: 'src/legacy/oldHelper.ts (nothing imports it)',
        why: 'Unreachable files are dead weight and slow down navigation and builds.',
        fixClassification: 'unsafe'
    },
    {
        id: 'DEAD011',
        title: 'Unreachable statement',
        category: 'deadCode',
        severity: 'MEDIUM',
        confidence: 'CERTAIN',
        description: 'Code appears after a return, throw, break, or continue in the same block.',
        explanation: 'Detected via AST control-flow analysis within each statement block.',
        example: 'return value;\nconsole.log("never runs");',
        why: 'Unreachable code cannot execute and misleads readers about program behavior.',
        fixClassification: 'safe'
    },

    // Dependencies
    {
        id: 'DEP001',
        title: 'Unused dependency',
        category: 'dependencies',
        severity: 'MEDIUM',
        confidence: 'CERTAIN',
        description: 'Dependency is declared but never referenced from the source tree, require/import calls, or scripts.',
        explanation: 'Reduces repository health and can hide package drift.',
        example: 'import { z } from "zod"; // package installed but not used',
        why: 'Unused packages increase install time, maintenance burden, and supply-chain risk.',
        fixClassification: 'safe'
    },
    {
        id: 'DEP002',
        title: 'Unlisted dependency',
        category: 'dependencies',
        severity: 'HIGH',
        confidence: 'HIGH',
        description: 'A module is imported but not declared anywhere in package.json.',
        explanation: 'The import resolves today only because a transitive dependency happens to provide it.',
        example: "import { pick } from 'lodash'; // lodash not in package.json",
        why: 'Relying on undeclared transitive dependencies breaks unpredictably on lockfile changes.',
        fixClassification: 'manual'
    },
    {
        id: 'DEP003',
        title: 'Circular import',
        category: 'dependencies',
        severity: 'MEDIUM',
        confidence: 'HIGH',
        description: 'A cycle exists in the internal module import graph.',
        explanation: 'Detected via depth-first traversal of the internal import graph.',
        example: 'a.ts imports b.ts, which imports a.ts',
        why: 'Import cycles cause initialization-order bugs and make modules hard to reason about independently.',
        fixClassification: 'manual'
    },

    // Complexity
    {
        id: 'COMPLEX001',
        title: 'High cyclomatic complexity function',
        category: 'complexity',
        severity: 'MEDIUM',
        confidence: 'HIGH',
        description: 'A function has more independent branches than the configured maximum.',
        explanation: 'Counted from if/for/while/case/catch/ternary/&&/|| nodes in the function body.',
        example: 'if (a && b || c) { ... }',
        why: 'Complex logic is harder to test, review, and safely refactor.',
        fixClassification: 'manual',
        defaultThreshold: 10
    },
    {
        id: 'COMPLEX002',
        title: 'High cognitive complexity function',
        category: 'complexity',
        severity: 'MEDIUM',
        confidence: 'HIGH',
        description: 'A function has more nesting-weighted branching than the configured maximum.',
        explanation: 'A simplified cognitive-complexity score that penalizes deep nesting more than flat branching.',
        example: 'deeply nested if/for/while blocks',
        why: 'Nested logic is disproportionately harder to hold in your head than flat logic of the same size.',
        fixClassification: 'manual',
        defaultThreshold: 15
    },
    {
        id: 'COMPLEX003',
        title: 'Function too long',
        category: 'complexity',
        severity: 'MEDIUM',
        confidence: 'HIGH',
        description: 'A function spans more lines than the configured maximum.',
        explanation: 'Measured from the function declaration start to its closing brace.',
        example: 'a 300-line function',
        why: 'Long functions usually do more than one job and are harder to review and test.',
        fixClassification: 'manual',
        defaultThreshold: 100
    },
    {
        id: 'COMPLEX004',
        title: 'Too many parameters',
        category: 'complexity',
        severity: 'MEDIUM',
        confidence: 'HIGH',
        description: 'A function declares more parameters than the configured maximum.',
        explanation: 'Counted directly from the function signature.',
        example: 'function create(a, b, c, d, e, f) { }',
        why: 'Long parameter lists are error-prone to call correctly and hard to extend.',
        fixClassification: 'manual',
        defaultThreshold: 5
    },
    {
        id: 'COMPLEX005',
        title: 'Excessive nesting depth',
        category: 'complexity',
        severity: 'MEDIUM',
        confidence: 'HIGH',
        description: 'A function nests control structures deeper than the configured maximum.',
        explanation: 'Measured as the deepest if/for/while/switch/catch nesting level reached in the function.',
        example: 'if { for { while { if { ... } } } }',
        why: 'Deep nesting is a strong readability and testability smell.',
        fixClassification: 'manual',
        defaultThreshold: 4
    },

    // Duplication
    {
        id: 'DUP001',
        title: 'Duplicate code block',
        category: 'duplication',
        severity: 'LOW',
        confidence: 'MEDIUM',
        description: 'An identical token sequence of at least the configured length appears in more than one location.',
        explanation: 'Detected via sliding-window token hashing (exact match, not semantic).',
        example: 'the same validation logic copy-pasted in two functions',
        why: 'Duplication causes divergence during fixes and makes review harder.',
        fixClassification: 'manual',
        defaultThreshold: 40
    },

    // Error handling
    {
        id: 'ERR001',
        title: 'Empty catch block',
        category: 'errorHandling',
        severity: 'MEDIUM',
        confidence: 'CERTAIN',
        description: 'An exception is caught and silently discarded.',
        explanation: 'Detected via AST inspection of catch block bodies.',
        example: 'try { risky(); } catch (e) { }',
        why: 'Swallowed exceptions hide real failures and make debugging production issues far harder.',
        fixClassification: 'manual'
    },
    {
        id: 'ERR002',
        title: 'Catch-and-rethrow without modification',
        category: 'errorHandling',
        severity: 'LOW',
        confidence: 'HIGH',
        description: 'A catch block does nothing but rethrow the original error unchanged.',
        explanation: 'Detected via AST inspection of catch block bodies.',
        example: 'try { risky(); } catch (e) { throw e; }',
        why: 'The try/catch adds no value and can be removed entirely.',
        fixClassification: 'manual'
    },
    {
        id: 'ERR003',
        title: 'Floating promise',
        category: 'errorHandling',
        severity: 'MEDIUM',
        confidence: 'MEDIUM',
        description: 'A Promise-like result is neither awaited nor handled.',
        explanation: 'Uses the TypeScript type checker to recognize Promise-returning calls, including methods and imported functions.',
        example: 'async function save() { }\nsave(); // not awaited',
        why: 'Unhandled promise rejections can crash the process or silently swallow errors.',
        fixClassification: 'manual'
    },
    {
        id: 'ERR004',
        title: 'Promise chain without rejection handler',
        category: 'errorHandling',
        severity: 'MEDIUM',
        confidence: 'MEDIUM',
        description: 'A .then() chain is not followed by a .catch() handler.',
        explanation: 'A rejected Promise can become an unhandled rejection when the chain has no error handler.',
        example: 'loadData().then(render);',
        why: 'Unhandled asynchronous errors can fail requests or terminate processes.',
        fixClassification: 'manual'
    },

    // Redundant logic
    {
        id: 'REDUNDANT001',
        title: 'Redundant boolean comparison',
        category: 'redundantLogic',
        severity: 'LOW',
        confidence: 'CERTAIN',
        description: 'A value is compared directly against the literal true or false.',
        explanation: 'Detected via AST inspection of equality expressions.',
        example: 'if (isValid === true) { }',
        why: 'The comparison is redundant; the expression can be used directly.',
        fixClassification: 'safe'
    },
    {
        id: 'REDUNDANT002',
        title: 'Impossible condition',
        category: 'redundantLogic',
        severity: 'MEDIUM',
        confidence: 'CERTAIN',
        description: 'An if-statement condition is a literal true or false.',
        explanation: 'Detected via AST inspection of if-statement conditions.',
        example: 'if (false) { neverRuns(); }',
        why: 'One branch can never execute, which is almost always an oversight.',
        fixClassification: 'unsafe'
    },

    // TypeScript quality
    {
        id: 'TS001',
        title: 'Unsafe any',
        category: 'typescript',
        severity: 'MEDIUM',
        confidence: 'CERTAIN',
        description: 'The code uses explicit or implicit any patterns that bypass TypeScript safety.',
        explanation: 'Any weakens type-checking and allows incorrect values to flow through an application.',
        example: 'const value: any = payload',
        why: 'It reduces compile-time guarantees and increases runtime failures.',
        fixClassification: 'unsafe'
    },
    {
        id: 'TS002',
        title: 'Suppressed type checking',
        category: 'typescript',
        severity: 'MEDIUM',
        confidence: 'CERTAIN',
        description: '@ts-ignore, @ts-nocheck, or @ts-expect-error disables checking.',
        explanation: 'Detected via comment scanning.',
        example: '// @ts-ignore\nconst x: number = "oops";',
        why: 'Suppressing errors hides real type problems instead of fixing them.',
        fixClassification: 'manual'
    },
    {
        id: 'TS003',
        title: 'Non-null assertion',
        category: 'typescript',
        severity: 'LOW',
        confidence: 'CERTAIN',
        description: 'The ! operator asserts a value is non-null without verifying it.',
        explanation: 'Detected via AST inspection for non-null assertion expressions.',
        example: 'const name = user!.name;',
        why: 'A wrong assertion becomes a runtime crash instead of a compile-time error.',
        fixClassification: 'manual'
    },

    // JavaScript quality (scored under hygiene per the PRD weighting table)
    {
        id: 'JS001',
        title: "'var' declaration",
        category: 'hygiene',
        severity: 'LOW',
        confidence: 'CERTAIN',
        description: 'var is used instead of let or const.',
        explanation: 'Detected via AST inspection of variable declaration lists.',
        example: 'var count = 0;',
        why: 'var is function-scoped and hoisted, which commonly causes bugs block-scoped declarations avoid.',
        fixClassification: 'unsafe'
    },
    {
        id: 'JS002',
        title: 'Loose equality',
        category: 'hygiene',
        severity: 'LOW',
        confidence: 'CERTAIN',
        description: '== or != is used where strict equality is expected.',
        explanation: '== null / != null are exempted as an intentional, common idiom.',
        example: 'if (value == 0) { }',
        why: 'Loose equality performs implicit type coercion, which can hide bugs.',
        fixClassification: 'unsafe'
    },

    // Security
    {
        id: 'SEC001',
        title: 'Hardcoded secret',
        category: 'security',
        severity: 'HIGH',
        confidence: 'HIGH',
        description: 'Potential secret material appears directly in source code.',
        explanation: 'Recognizes common provider token formats and high-entropy values assigned to credential-like variable names.',
        example: 'const apiKey = "sk_live_123"',
        why: 'Secrets in code create immediate security and operational risk.',
        fixClassification: 'manual'
    },
    {
        id: 'SEC002',
        title: 'Use of eval',
        category: 'security',
        severity: 'HIGH',
        confidence: 'CERTAIN',
        description: 'eval executes arbitrary strings as code.',
        explanation: 'Detected via AST inspection of call expressions.',
        example: "eval(userInput)",
        why: 'eval is a common injection vector and defeats static analysis and bundling.',
        fixClassification: 'manual'
    },
    {
        id: 'SEC003',
        title: 'Dangerous command execution',
        category: 'security',
        severity: 'HIGH',
        confidence: 'MEDIUM',
        description: 'A shell command is dynamically built or shell execution is explicitly enabled.',
        explanation: 'Checks dynamic command expressions, a one-hop local variable initializer, and shell: true on spawn-family calls.',
        example: 'exec(`rm -rf ${userPath}`)',
        why: 'Unsanitized dynamic shell commands are a classic command-injection vector.',
        fixClassification: 'manual'
    },
    {
        id: 'SEC004',
        title: 'Unsafe HTML assignment',
        category: 'security',
        severity: 'MEDIUM',
        confidence: 'MEDIUM',
        description: 'innerHTML/outerHTML is assigned to, or dangerouslySetInnerHTML is used.',
        explanation: 'Detected via AST, insertAdjacentHTML calls, and raw HTML bindings in Vue/HTML templates.',
        example: 'el.innerHTML = userContent;',
        why: 'Rendering unsanitized content as HTML is a common cross-site-scripting vector.',
        fixClassification: 'manual'
    },
    {
        id: 'SEC005',
        title: 'Weak cryptographic hash',
        category: 'security',
        severity: 'MEDIUM',
        confidence: 'HIGH',
        description: 'crypto.createHash is called with a weak algorithm (md5, sha1, des, rc4).',
        explanation: 'Detected via AST inspection of createHash call arguments.',
        example: "crypto.createHash('md5')",
        why: 'Weak hash algorithms are broken for integrity and security-sensitive use cases.',
        fixClassification: 'manual'
    },
    {
        id: 'SEC007',
        title: 'TLS certificate verification disabled',
        category: 'security',
        severity: 'HIGH',
        confidence: 'HIGH',
        description: 'NODE_TLS_REJECT_UNAUTHORIZED is set to 0.',
        explanation: 'Detected via text scanning for the environment variable assignment.',
        example: 'process.env.NODE_TLS' + '_REJECT_UNAUTHORIZED = "0"',
        why: 'Disabling TLS verification exposes the process to man-in-the-middle attacks.',
        fixClassification: 'manual'
    },
    {
        id: 'SEC008',
        title: 'Potential SQL injection',
        category: 'security',
        severity: 'HIGH',
        confidence: 'MEDIUM',
        description: 'A SQL query string is dynamically constructed.',
        explanation: 'Concatenating input into query syntax can allow an attacker to alter the query.',
        example: 'db.query(`SELECT * FROM users WHERE id = ${id}`);',
        why: 'Parameterized queries keep data separate from executable SQL.',
        fixClassification: 'manual'
    },
    {
        id: 'SEC009',
        title: 'Potential path traversal',
        category: 'security',
        severity: 'HIGH',
        confidence: 'LOW',
        description: 'A filesystem path may include untrusted request input.',
        explanation: 'Unvalidated path segments can escape an intended directory.',
        example: "readFile(path.join(root, req.params.file));",
        why: 'Path traversal can expose or overwrite files outside the intended area.',
        fixClassification: 'manual'
    },
    {
        id: 'SEC010',
        title: 'Unsafe deserialization or dynamic execution',
        category: 'security',
        severity: 'HIGH',
        confidence: 'MEDIUM',
        description: 'An unsafe deserializer or dynamic execution API is used.',
        explanation: 'Untrusted serialized values or code can trigger object construction or execution.',
        example: 'unserialize(input);',
        why: 'Unsafe deserialization can lead to code execution or unexpected object behavior.',
        fixClassification: 'manual'
    },

    // Architecture
    {
        id: 'ARCH001',
        title: 'Forbidden layer import',
        category: 'architecture',
        severity: 'HIGH',
        confidence: 'CERTAIN',
        description: 'A file in one architecture layer imports from a layer it is configured to never depend on.',
        explanation: 'Requires architecture.layers to be configured in .devkitrc.json; no findings without configuration.',
        example: 'a controller importing directly from the database layer',
        why: 'Layer violations erode the architecture boundaries a codebase relies on to stay maintainable.',
        fixClassification: 'manual'
    },

    // Hygiene
    {
        id: 'HYGIENE001',
        title: 'Debug statement',
        category: 'hygiene',
        severity: 'LOW',
        confidence: 'CERTAIN',
        description: 'Debugging output or test instrumentation remains in production code.',
        explanation: 'Console logging and debugger statements are noisy and can leak secrets.',
        example: 'console.log("debug")',
        why: 'Keeps logs noisy and can expose sensitive information.',
        fixClassification: 'safe'
    },
    {
        id: 'HYGIENE002',
        title: 'Temporary marker',
        category: 'hygiene',
        severity: 'LOW',
        confidence: 'MEDIUM',
        description: 'A TODO, FIXME, HACK, or XXX marker remains in the code.',
        explanation: 'Detected via text scanning.',
        example: '// TODO: handle edge case',
        why: 'Unresolved markers accumulate and signal untracked technical debt.',
        fixClassification: 'safe'
    },
    {
        id: 'HYGIENE003',
        title: 'Backup or temporary file committed',
        category: 'hygiene',
        severity: 'LOW',
        confidence: 'HIGH',
        description: 'A file with a backup/temp extension (.bak, .orig, .tmp, ~) is present.',
        explanation: 'Detected via filename pattern matching.',
        example: 'config.json.bak',
        why: 'Stray backup files clutter the repository and can contain stale secrets.',
        fixClassification: 'safe'
    },
    {
        id: 'HYGIENE004',
        title: 'Committed .env file',
        category: 'hygiene',
        severity: 'HIGH',
        confidence: 'MEDIUM',
        description: 'A .env file (not a .example/.sample/.template variant) is present in the repository.',
        explanation: 'Detected via filename pattern matching.',
        example: '.env',
        why: 'Environment files frequently contain live secrets and should never be committed.',
        fixClassification: 'manual'
    }
];

export function getRuleById(ruleId: string): RuleDefinition | undefined {
    return rules.find((rule) => rule.id === ruleId);
}

export function listRules(): RuleDefinition[] {
    return [...rules];
}
