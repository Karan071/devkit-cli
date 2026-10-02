import { describe, expect, it } from 'vitest';
import { determineExitFailure, filterFindings, validateGates } from '../cliLogic';
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

    it('accepts kebab-case, spaced and aliased category names', () => {
        const findings = [finding('DEAD002', 'MEDIUM', 'deadCode'), finding('TS001', 'MEDIUM', 'typescript')];
        expect(filterFindings(findings, { category: 'dead-code' })).toHaveLength(1);
        expect(filterFindings(findings, { category: 'Dead Code' })).toHaveLength(1);
        expect(filterFindings(findings, { category: 'type-safety' })).toHaveLength(1);
    });

    it('rejects a non-numeric or out-of-range --min-score instead of silently passing', () => {
        expect(validateGates({ minScore: 'abc' })).not.toBeNull();
        expect(validateGates({ minScore: '11' })).not.toBeNull();
        expect(validateGates({ minScore: '7.5' })).toBeNull();
        expect(determineExitFailure(summary, { minScore: 'abc' })).toBe(true);
    });

    it('fails a --min-score gate when no source files were analyzed', () => {
        const empty: ScanSummary = {
            ...summary, score: 10, findings: [],
            coverage: { discoveryMethod: 'filesystem', discoveredFiles: 0, analyzedFiles: 0, textFilesScanned: 0, generatedFilesSkipped: 0, tooLargeFilesSkipped: [], binaryFilesSkipped: 0, languages: {}, durationMs: 1 }
        };
        expect(determineExitFailure(empty, { minScore: '5' })).toBe(true);
    });
});
