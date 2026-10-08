import { isTestFile } from './discovery';

/**
 * What a file is *for*. Rules were written with shipped application code in mind; the same pattern
 * (`console.log`, an unused callback parameter, `md5` in a checksum test) means something different in a
 * test, a build script or an example, so each rule declares which kinds it applies to.
 */
export type FileKind = 'production' | 'test' | 'typeTest' | 'example' | 'benchmark' | 'script' | 'fixture';

const TYPE_TEST_FILE = /\.(?:tst|test-d|spec-d)\.[cm]?tsx?$|(?:^|\/)(?:types?[-_]?tests?|tsd|__tests?_dts__|tests?_dts)\//i;
const FIXTURE_DIR = /(?:^|\/)(?:fixtures?|__fixtures__|__mocks__|mocks?|testdata|test-data|snapshots?)\//i;
const EXAMPLE_DIR = /(?:^|\/)(?:examples?|samples?|demos?|sandbox|playground|docs?|documentation)\//i;
// Project scaffolds shipped for users to copy (create-vite/template-*, generators): real files, but never wired into the product.
const TEMPLATE_DIR = /(?:^|\/)(?:templates?|template-[^/]+|scaffolds?|boilerplates?|starters?|generators?\/templates?)\//i;
const BENCHMARK_DIR = /(?:^|\/)(?:bench(?:marks?)?|perf|performance)\//i;
const SCRIPT_DIR = /(?:^|\/)(?:scripts?|tools?|bin|\.github|\.husky|ci)\//i;

export function classifyFile(relativePath: string): FileKind {
    const path = relativePath.replace(/\\/g, '/');
    if (TYPE_TEST_FILE.test(path)) return 'typeTest';
    if (FIXTURE_DIR.test(path)) return 'fixture';
    if (isTestFile(path) || /(?:^|\/)(?:tests?|__tests__|spec|e2e|integration|cypress|playwright)\//i.test(path)) return 'test';
    // `test-resolution.ts`, `foo.test-utils.ts`: test code that is not in a test folder.
    if (/(?:^|\/)(?:tests?|spec)[-_.][^/]*$|[-_.](?:tests?|spec)\.[cm]?[jt]sx?$/i.test(path)) return 'test';
    if (BENCHMARK_DIR.test(path) || /(?:^|\/)packages\/bench\b/i.test(path)) return 'benchmark';
    if (EXAMPLE_DIR.test(path) || TEMPLATE_DIR.test(path)) return 'example';
    if (SCRIPT_DIR.test(path)) return 'script';
    return 'production';
}

export function isProductionFile(relativePath: string): boolean {
    return classifyFile(relativePath) === 'production';
}

/**
 * Where each rule is meaningful. Rules not listed apply everywhere.
 * `production` = shipped application/library code only.
 * `runtime` = production plus build/CLI scripts, which execute for real even though they are not the product.
 */
type Scope = 'production' | 'runtime' | 'everywhere';

const RULE_SCOPE: Record<string, Scope> = {
    // Noise-prone style, typing and hygiene rules: judged on shipped code only.
    TS001: 'production', TS002: 'production', TS003: 'production',
    JS001: 'production', JS002: 'production', JS003: 'production',
    HYGIENE001: 'production', HYGIENE002: 'production',
    DEAD003: 'production', DEAD004: 'production', DEAD005: 'production', DEAD006: 'production', DEAD007: 'production',
    DEAD009: 'production', DEAD010: 'production',
    ERR001: 'production', ERR002: 'production', ERR003: 'production', ERR004: 'production',
    REDUNDANT001: 'production', REDUNDANT002: 'production',
    DUP001: 'production',
    COMPLEX001: 'production', COMPLEX002: 'production', COMPLEX003: 'production', COMPLEX004: 'production', COMPLEX005: 'production',
    // Injection / crypto / TLS rules describe attacker-reachable code. Test servers legitimately disable TLS
    // checks, hash with md5 and eval snippets. Secret detection (SEC001) stays everywhere: a real key
    // committed in a test file is still a leaked key.
    SEC002: 'runtime', SEC003: 'runtime', SEC004: 'runtime', SEC005: 'runtime', SEC006: 'runtime',
    SEC007: 'runtime', SEC008: 'runtime', SEC009: 'runtime', SEC010: 'runtime',
    SEC011: 'runtime', SEC012: 'runtime', SEC013: 'runtime', SEC014: 'runtime',
    DEP003: 'production'
};

export function ruleAppliesTo(ruleId: string, relativePath: string): boolean {
    const scope = RULE_SCOPE[ruleId] ?? 'everywhere';
    if (scope === 'everywhere') return true;
    const kind = classifyFile(relativePath);
    return kind === 'production' || (scope === 'runtime' && kind === 'script');
}
