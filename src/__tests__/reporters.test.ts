import { describe, expect, it } from 'vitest';
import { formatBaselineCompare, formatJson, formatMarkdown, formatMetrics, formatSarif } from '../reporters';
import type { ScanSummary } from '../types';

const summary: ScanSummary = {
    repository: '/workspace/example', score: 8.5, categoryScores: { security: 9 }, securityScore: 9,
    findings: [{
        id: 'SEC002-src/index.ts-4-3', ruleId: 'SEC002', category: 'security', severity: 'HIGH', confidence: 'CERTAIN',
        file: 'src/index.ts', line: 4, column: 3, message: 'Use of eval', description: 'Dynamic evaluation is unsafe.',
        evidence: 'eval(input)', suggestion: 'Use a safe parser.', fixAvailable: false
    }],
    metrics: {
        totalFiles: 2, sourceFiles: 1, testFiles: 1, totalLOC: 20, sourceLOC: 12, testLOC: 8, commentLOC: 2,
        functionCount: 3, classCount: 0, dependencyCount: 1, averageFunctionSize: 4,
        largestFunctions: [{ name: 'run', size: 4, file: 'src/index.ts' }], largestFiles: [{ file: 'src/index.ts', loc: 12 }],
        complexityDistribution: { low: 3, medium: 0, high: 0 }, duplicationPercentage: 0, deadCodePercentage: 0, testToSourceRatio: 8 / 12
    },
    generatedFiles: []
};

describe('reporters', () => {
    it('formats JSON and SARIF as valid machine-readable documents', () => {
        expect(JSON.parse(formatJson(summary)).findings[0].ruleId).toBe('SEC002');
        expect(JSON.parse(formatSarif(summary)).runs[0].results[0].ruleId).toBe('SEC002');
    });

    it('formats Markdown and repository metrics', () => {
        expect(formatMarkdown(summary)).toContain('SEC002');
        expect(formatMetrics(summary)).toContain('sourceLOC');
    });

    it('reports score changes against a baseline', () => {
        expect(formatBaselineCompare(8, 8.5)).toContain('0.5');
    });
});
