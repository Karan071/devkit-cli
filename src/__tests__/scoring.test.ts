import { describe, expect, it } from 'vitest';
import { computeScores, summarizeTopDeductions } from '../scoring';
import type { Finding } from '../types';

function finding(overrides: Partial<Finding>): Finding {
    return {
        id: 'id',
        ruleId: 'TEST001',
        category: 'hygiene',
        severity: 'LOW',
        confidence: 'CERTAIN',
        file: 'src/index.ts',
        line: 1,
        column: 1,
        message: 'message',
        description: 'description',
        evidence: 'evidence',
        suggestion: 'suggestion',
        fixAvailable: false,
        ...overrides
    };
}

describe('computeScores', () => {
    it('returns a perfect score with no findings', () => {
        const result = computeScores([], 1000);
        expect(result.overallScore).toBe(10);
        expect(result.securityScore).toBe(10);
        for (const score of Object.values(result.categoryScores)) {
            expect(score).toBe(10);
        }
    });

    it('lowers only the affected category for a single finding', () => {
        const result = computeScores([finding({ category: 'hygiene', severity: 'LOW', confidence: 'CERTAIN' })], 1000);
        expect(result.categoryScores.hygiene).toBeLessThan(10);
        expect(result.categoryScores.deadCode).toBe(10);
    });

    it('keeps security out of the blended overall score', () => {
        const withSecurity = computeScores([finding({ category: 'security', severity: 'CRITICAL', confidence: 'CERTAIN' })], 100);
        expect(withSecurity.overallScore).toBe(10);
        expect(withSecurity.securityScore).toBeLessThan(10);
    });

    it('penalizes the same finding count less in a larger repository', () => {
        const findings = [finding({ severity: 'HIGH', confidence: 'CERTAIN' })];
        const small = computeScores(findings, 100);
        const large = computeScores(findings, 50000);
        expect(large.categoryScores.hygiene).toBeGreaterThan(small.categoryScores.hygiene);
    });
});

describe('summarizeTopDeductions', () => {
    it('groups and ranks findings by rule id', () => {
        const findings = [
            finding({ ruleId: 'A', severity: 'LOW', confidence: 'CERTAIN' }),
            finding({ ruleId: 'A', severity: 'LOW', confidence: 'CERTAIN' }),
            finding({ ruleId: 'B', severity: 'CRITICAL', confidence: 'CERTAIN' })
        ];

        const result = summarizeTopDeductions(findings);
        expect(result[0].ruleId).toBe('B');
        expect(result.find((d) => d.ruleId === 'A')?.count).toBe(2);
    });
});
