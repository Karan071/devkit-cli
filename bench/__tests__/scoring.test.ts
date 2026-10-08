import { describe, expect, it } from 'vitest';
import { checkGate, evaluate, findMarkerLine, parseLabels, toBaseline, type BenchFinding, type EvaluateInput, type Expectations } from '../lib/scoring';
import { sampleFindings } from '../lib/sample';
import { fillPlaceholders } from '../lib/seeded';

const finding = (ruleId: string, file: string, line: number, confidence: BenchFinding['confidence'] = 'HIGH'): BenchFinding => ({ ruleId, file, line, confidence });

const expectations: Expectations = {
    planted: [
        { id: 'eval', rule: 'SEC002', file: 'a.ts' },
        { id: 'tls', rule: 'SEC007', file: 'b.ts', issue: 'G1' }
    ],
    decoys: [
        { id: 'comment', rule: 'SEC001', file: 'c.ts' },
        { id: 'fixture', rule: 'SEC001', file: 'd.ts', tolerate: 'LOW' }
    ]
};
const markerLines = new Map<string, number | 'any'>([['planted:eval', 3], ['planted:tls', 5], ['decoy:comment', 1], ['decoy:fixture', 2]]);

function run(overrides: Partial<EvaluateInput>) {
    return evaluate({ ruleIds: ['SEC001', 'SEC002', 'SEC007'], seededFindings: [], expectations, markerLines, corpusFindings: {}, labels: [], ...overrides });
}

describe('findMarkerLine', () => {
    it('finds the line carrying the marker and not a longer id', () => {
        const text = 'a\nb // planted: eval-x\nc // planted: eval\n';
        expect(findMarkerLine(text, 'planted', 'eval')).toBe(3);
        expect(findMarkerLine(text, 'decoy', 'eval')).toBeNull();
    });
});

describe('evaluate', () => {
    it('counts caught planted issues and separates known gaps from misses', () => {
        const report = run({ seededFindings: [finding('SEC002', 'a.ts', 3)] });
        expect(report.catchRate).toEqual({ total: 2, caught: 1, percent: 50 });
        expect(report.missed).toEqual([]);
        expect(report.planted.find((entry) => entry.id === 'tls')?.caught).toBe(false);
    });

    it('reports a planted issue without a tracking item as missed', () => {
        const report = run({ seededFindings: [] });
        expect(report.missed.map((entry) => entry.id)).toEqual(['eval']);
    });

    it('counts a finding on a decoy as a false positive unless its confidence is tolerated', () => {
        const report = run({ seededFindings: [finding('SEC002', 'a.ts', 3), finding('SEC001', 'c.ts', 1), finding('SEC001', 'd.ts', 2, 'LOW')] });
        const sec001 = report.rules.find((score) => score.rule === 'SEC001');
        expect(sec001).toMatchObject({ truePositives: 0, falsePositives: 1, accuracy: 0 });
        expect(report.flaggedDecoys.map((entry) => entry.id)).toEqual(['comment']);
    });

    it('does not score findings that match neither a planted issue nor a decoy', () => {
        const report = run({ seededFindings: [finding('SEC002', 'a.ts', 3), finding('SEC002', 'z.ts', 9)] });
        expect(report.unlabeledSeeded).toBe(1);
        expect(report.rules.find((score) => score.rule === 'SEC002')).toMatchObject({ labeled: 1, accuracy: 100 });
    });

    it('scores corpus findings through hand labels and flags labels that no longer match', () => {
        const labels = parseLabels(
            [
                '{"repo":"zod","rule":"SEC001","file":"x.ts","line":1,"verdict":true,"reason":"real key"}',
                '{"repo":"zod","rule":"SEC001","file":"x.ts","line":2,"verdict":false,"reason":"comment"}',
                '{"repo":"zod","rule":"SEC001","file":"gone.ts","line":1,"verdict":true,"reason":"moved"}',
                '{"repo":"hono","rule":"SEC001","file":"y.ts","line":1,"verdict":true,"reason":"repo not scanned"}'
            ].join('\n'),
            'labels.jsonl'
        );
        const report = run({ corpusFindings: { zod: [finding('SEC001', 'x.ts', 1), finding('SEC001', 'x.ts', 2), finding('SEC001', 'x.ts', 3)] }, labels });
        expect(report.rules.find((score) => score.rule === 'SEC001')).toMatchObject({ truePositives: 1, falsePositives: 1, accuracy: 50 });
        expect(report.staleLabels).toBe(1);
    });

    it('lists every known rule even with no labels', () => {
        const report = run({});
        expect(report.rules.map((score) => score.rule)).toEqual(['SEC001', 'SEC002', 'SEC007']);
        expect(report.rules.every((score) => score.accuracy === null)).toBe(true);
    });
});

describe('parseLabels', () => {
    it('skips unlabeled samples and rejects malformed JSON with its location', () => {
        expect(parseLabels('{"repo":"r","rule":"X","file":"f","line":1,"verdict":null,"reason":""}\n', 's')).toEqual([]);
        expect(() => parseLabels('{oops', 'labels/r.jsonl')).toThrow('labels/r.jsonl:1');
    });
});

describe('checkGate', () => {
    const planted = [finding('SEC002', 'a.ts', 3), finding('SEC007', 'b.ts', 5)];

    it('passes when every planted issue is found and accuracy holds', () => {
        const report = run({ seededFindings: planted });
        const gate = checkGate(report, toBaseline(report));
        expect(gate.ok).toBe(true);
        expect(gate.warnings.some((warning) => warning.includes('"tls"'))).toBe(true);
    });

    it('fails when a planted issue is missed', () => {
        const gate = checkGate(run({ seededFindings: [] }), null);
        expect(gate.ok).toBe(false);
        expect(gate.failures[0]).toContain('"eval"');
    });

    it('fails when a rule loses more than 2 accuracy points and tolerates 2 or fewer', () => {
        const baseline = { rules: { SEC002: { accuracy: 100, labeled: 1 } } };
        const labelsFor = (verdicts: boolean[]) => ({
            corpusFindings: { zod: verdicts.map((_, index) => finding('SEC002', 'x.ts', index + 1)) },
            labels: verdicts.map((verdict, index) => ({ repo: 'zod', rule: 'SEC002', file: 'x.ts', line: index + 1, verdict, reason: '' }))
        });

        const dropped = checkGate(run({ seededFindings: planted, ...labelsFor([true, false]) }), baseline);
        expect(dropped.ok).toBe(false);
        expect(dropped.failures.join(' ')).toContain('SEC002 accuracy fell from 100% to');

        const withinTolerance = checkGate(run({ seededFindings: planted, ...labelsFor(Array.from({ length: 50 }, (_, index) => index !== 0)) }), baseline);
        expect(withinTolerance.ok).toBe(true);
    });
});

describe('sampleFindings', () => {
    const many = Array.from({ length: 100 }, (_, index) => finding(index % 2 ? 'SEC001' : 'SEC002', `f${index}.ts`, index + 1));

    it('is deterministic and caps findings per rule', () => {
        const first = sampleFindings(many, 10);
        expect(sampleFindings([...many].reverse(), 10)).toEqual(first);
        expect(first.filter((entry) => entry.ruleId === 'SEC001')).toHaveLength(10);
        expect(first.filter((entry) => entry.ruleId === 'SEC002')).toHaveLength(10);
    });
});

describe('fillPlaceholders', () => {
    it('replaces known placeholders and leaves unknown ones alone', () => {
        expect(fillPlaceholders("'@@AWS_ACCESS_KEY@@'")).toMatch(/^'AKIA[0-9A-Z]{16}'$/);
        expect(fillPlaceholders('@@NOPE@@')).toBe('@@NOPE@@');
    });
});
