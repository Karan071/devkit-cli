import fs from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { scanRepository } from '../../src/scanner';
import { SEEDED_DIR, materializeSeeded } from '../lib/seeded';
import { checkGate, evaluate, readExpectations } from '../lib/scoring';

const dir = materializeSeeded();
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('seeded benchmark repo', () => {
    const { expectations, lines } = readExpectations(SEEDED_DIR);
    const findings = scanRepository(dir).findings;
    const report = evaluate({ ruleIds: [], seededFindings: findings, expectations, markerLines: lines, corpusFindings: {}, labels: [] });

    it('has every planted issue reported by its rule, except tracked gaps', () => {
        expect(report.missed).toEqual([]);
        expect(checkGate(report, null).failures).toEqual([]);
    });

    it('keeps tracked gaps and false positives honest', () => {
        expect(report.resolvedGaps).toEqual([]);
        expect(report.resolvedDecoys).toEqual([]);
    });

    it('contains no literal provider tokens in the committed sources', () => {
        const text = fs.readFileSync(`${SEEDED_DIR}/src/config.ts`, 'utf8');
        expect(text).not.toMatch(/AKIA[0-9A-Z]{16}|sk_live_|ghp_/);
        expect(fs.readFileSync(`${dir}/src/config.ts`, 'utf8')).toMatch(/AKIA[0-9A-Z]{16}/);
    });
});
