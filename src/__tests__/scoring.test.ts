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

    it('folds security into the overall score and caps it on a credible security finding', () => {
        const withSecurity = computeScores([finding({ category: 'security', severity: 'CRITICAL', confidence: 'CERTAIN' })], 100);
        expect(withSecurity.securityScore).toBeLessThan(10);
        expect(withSecurity.overallScore).toBeLessThanOrEqual(6.9);
        expect(withSecurity.securityCapped).toBe(true);
    });

    it('does not cap the score for low-confidence or test-file security findings', () => {
        const lowConfidence = computeScores([finding({ category: 'security', severity: 'HIGH', confidence: 'LOW' })], 1000);
        const inTest = computeScores([finding({ category: 'security', severity: 'HIGH', confidence: 'HIGH', file: 'src/a.test.ts' })], 1000);
        expect(lowConfidence.securityCapped).toBe(false);
        expect(inTest.securityCapped).toBe(false);
    });

    it('does not let a large codebase dilute a leaked secret away', () => {
        const leaks = Array.from({ length: 5 }, () => finding({ category: 'security', severity: 'HIGH', confidence: 'HIGH' }));
        expect(computeScores(leaks, 50000).securityScore).toBeLessThan(9);
    });

    it('excludes architecture from the blend when no layers are configured', () => {
        const result = computeScores([], 1000, { architectureConfigured: false });
        expect(result.categoryScores).not.toHaveProperty('architecture');
        expect(result.overallScore).toBe(10);
    });

    it('weighs findings in test files at half the penalty', () => {
        const inSource = computeScores([finding({ severity: 'HIGH' })], 100);
        const inTest = computeScores([finding({ severity: 'HIGH', file: 'src/__tests__/a.test.ts' })], 100);
        expect(inTest.categoryScores.hygiene).toBeGreaterThan(inSource.categoryScores.hygiene);
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
