import { describe, expect, it } from 'vitest';
import { determineExitFailure, filterFindings } from '../cliLogic';
import type { Finding, ScanSummary } from '../types';

const finding = (ruleId: string, severity: Finding['severity'], category = 'security'): Finding => ({
    id: `${ruleId}-file-1-1`, ruleId, category, severity, confidence: 'HIGH', file: 'src/file.ts', line: 1, column: 1,
    message: ruleId, description: ruleId, evidence: ruleId, suggestion: 'fix', fixAvailable: false
});
const summary: ScanSummary = {
    repository: '.', score: 7, categoryScores: {}, securityScore: 7, findings: [finding('SEC001', 'HIGH'), finding('ERR001', 'LOW', 'errorHandling')],
    metrics: {
        totalFiles: 1, sourceFiles: 1, testFiles: 0, totalLOC: 1, sourceLOC: 1, testLOC: 0, commentLOC: 0, functionCount: 0,
        classCount: 0, dependencyCount: 0, averageFunctionSize: 0, largestFunctions: [], largestFiles: [],
        complexityDistribution: { low: 0, medium: 0, high: 0 }, duplicationPercentage: 0, deadCodePercentage: 0, testToSourceRatio: 0
    }, generatedFiles: []
};

describe('CLI scan logic', () => {
    it('filters findings by category and severity without mutating the source list', () => {
        expect(filterFindings(summary.findings, { severity: 'high' })).toHaveLength(1);
        expect(filterFindings(summary.findings, { category: 'security' })).toHaveLength(1);
        expect(summary.findings).toHaveLength(2);
    });

    it('applies score and severity exit gates', () => {
        expect(determineExitFailure(summary, { minScore: '8' })).toBe(true);
        expect(determineExitFailure(summary, { failOn: 'HIGH' })).toBe(true);
        expect(determineExitFailure(summary, { failOn: 'CRITICAL' })).toBe(false);
        expect(determineExitFailure(summary, { failOn: 'unknown' })).toBe(true);
    });
});
