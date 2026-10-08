import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

let dir: string | undefined;

afterEach(() => {
    if (dir) cleanupFixture(dir);
    dir = undefined;
});

const scan = (files: Record<string, string>) => {
    dir = makeFixture({ 'package.json': JSON.stringify({ name: 'fixture', main: 'src/index.ts' }), ...files });
    return scanRepository(dir);
};

describe('ERR003 floating promises (R1)', () => {
    it('reports a plain floating promise at HIGH confidence', () => {
        const [finding] = findingsFor(scan({ 'src/index.ts': `async function load(): Promise<void> {}\nexport function run() {\n    load();\n}\n` }).findings, 'ERR003');
        expect(finding.confidence).toBe('HIGH');
    });

    it('ignores a call whose type is void | Promise, because callers may legitimately not wait', () => {
        const source = `declare const stream: { close(): void | Promise<void> };\nexport function run() {\n    stream.close();\n}\n`;
        expect(findingsFor(scan({ 'src/index.ts': source }).findings, 'ERR003')).toHaveLength(0);
    });

    it('ignores Object.assign decorating a promise and void-prefixed calls', () => {
        const source = `async function load(): Promise<void> {}\nexport function run() {\n    Object.assign(load(), { extra: 1 });\n    void load();\n}\n`;
        expect(findingsFor(scan({ 'src/index.ts': source }).findings, 'ERR003')).toHaveLength(0);
    });

    it('lowers confidence inside a React effect', () => {
        const source = `declare function useEffect(effect: () => void): void;\nasync function load(): Promise<void> {}\nexport function Component() {\n    useEffect(() => {\n        load();\n    });\n}\n`;
        const [finding] = findingsFor(scan({ 'src/index.ts': source }).findings, 'ERR003');
        expect(finding.confidence).toBe('LOW');
    });
});

describe('JS002 loose equality idioms (R2)', () => {
    const loose = (source: string) => findingsFor(scan({ 'src/index.ts': `export function f(x: unknown, y: unknown) {\n    return ${source};\n}\n` }).findings, 'JS002');

    it.each(['typeof x != "undefined"', 'typeof x == "string"', '"object" == typeof x', 'x == null', 'x != undefined', 'x == void 0'])('allows %s', (expression) => {
        expect(loose(expression)).toHaveLength(0);
    });

    it.each(['x == y', 'x != 0', 'x == "1"'])('still flags %s', (expression) => {
        expect(loose(expression)).toHaveLength(1);
    });
});

describe('generated files detected by shape (R3)', () => {
    it('skips Emscripten glue, long-line bundles and banner-led vendored bundles, but not ordinary code', () => {
        const filler = (n: number) => Array.from({ length: n }, (_, i) => `var v${i}=${i};`).join('\n');
        const summary = scan({
            'src/index.ts': 'export const a = 1;\n',
            'src/emscripten.ts': `var Module = typeof Module != 'undefined' ? Module : {};\n${filler(300)}\nexport default Module;\n`,
            'src/wasm.ts': `export const bytes = '${'A'.repeat(4000)}';\nexport const other = '${'B'.repeat(4000)}';\n`,
            'src/vendor.js': `/*! lib v1.0 | MIT License */\n${Array.from({ length: 30 }, (_, i) => `var f${i}=function(a,b){return a+b+${i}}; var g${i}=function(c){return c*${i}+${'x'.repeat(100)}};`).join('\n')}\n`,
            'src/normal.ts': `${filler(120)}\nexport const b = 2;\n`
        });
        expect(summary.generatedFiles.sort()).toEqual(['src/emscripten.ts', 'src/vendor.js', 'src/wasm.ts']);
    });
});

describe('DUP001 duplicates (R4)', () => {
    const block = (prefix: string) => Array.from({ length: 50 }, (_, i) => `    ${prefix}total = ${prefix}total + value${i} * ${i} - offset${i};`).join('\n');
    const fn = (name: string, prefix = '') => `export function ${name}(${prefix}total: number) {\n${block(prefix)}\n    return ${prefix}total;\n}\n`;

    it('reports one finding for a function copied into four files', () => {
        const found = findingsFor(scan({ 'src/a.ts': fn('a'), 'src/b.ts': fn('b'), 'src/c.ts': fn('c'), 'src/d.ts': fn('d') }).findings, 'DUP001');
        expect(found).toHaveLength(1);
        expect(found[0].description).toContain('4 places');
    });

    it('skips locale, i18n and fixture directories', () => {
        const found = findingsFor(scan({ 'src/locale/en.ts': fn('en'), 'src/locale/fr.ts': fn('fr'), 'src/i18n/de.ts': fn('de'), 'src/fixtures/x.ts': fn('x') }).findings, 'DUP001');
        expect(found).toHaveLength(0);
    });

    it('ignores mostly-literal data tables', () => {
        const table = (name: string) => `export const ${name} = {\n${Array.from({ length: 40 }, (_, i) => `    key${i}: 'value number ${i}',`).join('\n')}\n};\n`;
        expect(findingsFor(scan({ 'src/a.ts': table('a'), 'src/b.ts': table('b') }).findings, 'DUP001')).toHaveLength(0);
    });
});
