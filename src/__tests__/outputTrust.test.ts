import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { computeScores, dampenRuleCost } from '../scoring';
import { RULE_ACCURACY, isShownByDefault } from '../ruleQuality';
import { buildFinding, fingerprint } from '../finding';
import { formatMarkdown } from '../reporters';
import type { Confidence, Finding, Severity } from '../types';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

let dir: string | undefined;

afterEach(() => {
    if (dir) cleanupFixture(dir);
    dir = undefined;
    delete RULE_ACCURACY.TEST900;
});

const make = (overrides: Partial<Finding> = {}): Finding => buildFinding({
    ruleId: 'HYGIENE001', category: 'hygiene', severity: 'MEDIUM' as Severity, confidence: 'HIGH' as Confidence, file: 'src/a.ts', line: 1, column: 1,
    message: 'm', description: 'd', evidence: 'console.log(x)', suggestion: 's', ...overrides
});

describe('default output filter (O1)', () => {
    it('shows HIGH and CERTAIN findings and hides MEDIUM, LOW and INFO ones', () => {
        expect(isShownByDefault(make({ confidence: 'CERTAIN' }))).toBe(true);
        expect(isShownByDefault(make({ confidence: 'HIGH' }))).toBe(true);
        expect(isShownByDefault(make({ confidence: 'MEDIUM' }))).toBe(false);
        expect(isShownByDefault(make({ confidence: 'LOW' }))).toBe(false);
        expect(isShownByDefault(make({ confidence: 'CERTAIN', severity: 'INFO' }))).toBe(false);
    });

    it('keeps serious security findings visible at MEDIUM confidence, but not LOW', () => {
        expect(isShownByDefault(make({ category: 'security', severity: 'HIGH', confidence: 'MEDIUM' }))).toBe(true);
        expect(isShownByDefault(make({ category: 'security', severity: 'HIGH', confidence: 'LOW' }))).toBe(false);
        expect(isShownByDefault(make({ category: 'security', severity: 'LOW', confidence: 'MEDIUM' }))).toBe(false);
    });

    it('hides a rule measured below 85% accuracy, but only once enough findings were labeled', () => {
        const finding = make({ ruleId: 'TEST900', confidence: 'CERTAIN' });
        RULE_ACCURACY.TEST900 = { accuracy: 60, labeled: 3 };
        expect(isShownByDefault(finding)).toBe(true);
        RULE_ACCURACY.TEST900 = { accuracy: 60, labeled: 30 };
        expect(isShownByDefault(finding)).toBe(false);
        RULE_ACCURACY.TEST900 = { accuracy: 90, labeled: 30 };
        expect(isShownByDefault(finding)).toBe(true);
    });
});

describe('per-rule score cap (O2)', () => {
    it('counts a rule in full up to the knee and only logarithmically beyond it', () => {
        expect(dampenRuleCost(1.5)).toBe(1.5);
        expect(dampenRuleCost(2)).toBe(2);
        expect(dampenRuleCost(100)).toBeLessThan(8);
        expect(dampenRuleCost(10_000)).toBeLessThan(12);
    });

    it('lets one noisy rule lose points more slowly than the number of its findings grows', () => {
        const anys = (count: number) => Array.from({ length: count }, (_, i) => make({ ruleId: 'TS001', category: 'typescript', severity: 'MEDIUM', confidence: 'CERTAIN', line: i + 1, evidence: `any${i}` }));
        const few = computeScores(anys(100), 5000).categoryScores.typescript;
        const many = computeScores(anys(1000), 5000).categoryScores.typescript;
        // Ten times the findings costs well under ten times the points.
        expect(10 - many).toBeLessThan((10 - few) * 4);
    });

    it('does not let one noisy rule hide a different rule in the same category', () => {
        const noisy = Array.from({ length: 800 }, (_, i) => make({ ruleId: 'TS001', category: 'typescript', severity: 'MEDIUM', confidence: 'CERTAIN', evidence: `any${i}` }));
        const other = Array.from({ length: 30 }, (_, i) => make({ ruleId: 'TS002', category: 'typescript', severity: 'HIGH', confidence: 'CERTAIN', evidence: `ts-ignore${i}` }));
        const both = computeScores([...noisy, ...other], 3000);
        const onlyNoisy = computeScores(noisy, 3000);
        expect(both.categoryScores.typescript).toBeLessThan(onlyNoisy.categoryScores.typescript);
    });
});

describe('headline score covers production code only (O3)', () => {
    it('ignores findings in tests but still lists them with --audit semantics', () => {
        const prod = { 'src/index.ts': 'export function f() {\n    var a = 1;\n    return a;\n}\n' };
        dir = makeFixture({ 'package.json': JSON.stringify({ name: 'x', main: 'src/index.ts' }), ...prod });
        const base = scanRepository(dir);
        cleanupFixture(dir);

        dir = makeFixture({
            'package.json': JSON.stringify({ name: 'x', main: 'src/index.ts' }),
            ...prod,
            'src/index.test.ts': `export function g() {\n${Array.from({ length: 40 }, (_, i) => `    const v${i} = ${i};`).join('\n')}\n}\n`
        });
        const withTests = scanRepository(dir, () => undefined, { includeNonProduction: true });
        expect(findingsFor(withTests.findings, 'DEAD003').length).toBeGreaterThan(findingsFor(base.findings, 'DEAD003').length);
        expect(withTests.score).toBe(base.score);
        expect(withTests.categoryScores).toEqual(base.categoryScores);
        expect(withTests.coverage?.nonProductionFindingsUnscored).toBeGreaterThan(0);
    });
});

describe('score drains (O4)', () => {
    it('lists the top three rules by points lost, largest first', () => {
        const rule = (ruleId: string, category: string, count: number, severity: Severity) =>
            Array.from({ length: count }, (_, i) => make({ ruleId, category, severity, confidence: 'CERTAIN', evidence: `${ruleId}${i}` }));
        const result = computeScores([...rule('A', 'hygiene', 3, 'LOW'), ...rule('B', 'deadCode', 40, 'MEDIUM'), ...rule('C', 'complexity', 10, 'HIGH'), ...rule('D', 'duplication', 1, 'LOW')], 2000);
        expect(result.drains.map((drain) => drain.ruleId).slice(0, 3)).toEqual(['B', 'C', 'A']);
        expect(result.drains[0].pointsLost).toBeGreaterThan(result.drains[1].pointsLost);
    });

    it('is shown in the report with the cost', () => {
        dir = makeFixture({ 'package.json': JSON.stringify({ name: 'x', main: 'src/index.ts' }), 'src/index.ts': 'export function f() {\n    var a = 1;\n    return a;\n}\n' });
        const summary = scanRepository(dir);
        expect(summary.scoreDrains?.length).toBeGreaterThan(0);
        expect(formatMarkdown(summary)).toMatch(/Biggest score drains[\s\S]*JS001[\s\S]*-0\.\d\d points/);
    });
});

describe('import cycle chain (O5)', () => {
    it('shows each file with the line that imports the next, back to the start', () => {
        dir = makeFixture({
            'package.json': JSON.stringify({ name: 'x', main: 'src/a.ts' }),
            'src/a.ts': `// header\nimport { b } from './b';\nexport const a = () => b;\n`,
            'src/b.ts': `import { c } from './c';\nexport const b = () => c;\n`,
            'src/c.ts': `\n\nimport { a } from './a';\nexport const c = () => a;\n`
        });
        const [cycle] = findingsFor(scanRepository(dir).findings, 'DEP003');
        expect(cycle.description).toContain('src/a.ts:2 → src/b.ts:1 → src/c.ts:3 → src/a.ts');
        expect(cycle.line).toBe(2);
    });
});

describe('stable fingerprints (O6)', () => {
    const source = 'export function f() {\n    var a = 1;\n    var b = 2;\n    return a + b;\n}\n';

    it('does not depend on the line number', () => {
        expect(fingerprint('JS001', 'src/a.ts', 'var   a = 1;')).toBe(fingerprint('JS001', 'src/a.ts', 'var a = 1;'));
        expect(fingerprint('JS001', 'src/a.ts', 'var a = 1;')).not.toBe(fingerprint('JS001', 'src/b.ts', 'var a = 1;'));
    });

    it('survives code being added above the finding', () => {
        dir = makeFixture({ 'package.json': JSON.stringify({ name: 'x', main: 'src/index.ts' }), 'src/index.ts': source });
        const before = findingsFor(scanRepository(dir).findings, 'JS001');
        cleanupFixture(dir);
        dir = makeFixture({ 'package.json': JSON.stringify({ name: 'x', main: 'src/index.ts' }), 'src/index.ts': `// a new comment\n\n${source}` });
        const after = findingsFor(scanRepository(dir).findings, 'JS001');
        expect(after.map((finding) => finding.line)).not.toEqual(before.map((finding) => finding.line));
        expect(after.map((finding) => finding.id).sort()).toEqual(before.map((finding) => finding.id).sort());
    });

    it('keeps ids unique when the same code appears twice in a file', () => {
        dir = makeFixture({ 'package.json': JSON.stringify({ name: 'x', main: 'src/index.ts' }), 'src/index.ts': 'export function f() {\n    var a = 1;\n    return a;\n}\nexport function g() {\n    var a = 1;\n    return a;\n}\n' });
        const ids = findingsFor(scanRepository(dir).findings, 'JS001').map((finding) => finding.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toHaveLength(2);
    });
});
