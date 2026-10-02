import type { Confidence, Finding, Severity } from './types';

export const CATEGORY_WEIGHTS: Record<string, number> = {
    deadCode: 0.2,
    dependencies: 0.1,
    complexity: 0.15,
    duplication: 0.1,
    redundantLogic: 0.1,
    errorHandling: 0.1,
    typescript: 0.1,
    architecture: 0.1,
    hygiene: 0.05
};

const SEVERITY_WEIGHT: Record<Severity, number> = {
    CRITICAL: 3,
    HIGH: 2.5,
    MEDIUM: 1.5,
    LOW: 0.8,
    INFO: 0.2
};

const CONFIDENCE_WEIGHT: Record<Confidence, number> = {
    CERTAIN: 1,
    HIGH: 0.8,
    MEDIUM: 0.6,
    LOW: 0.3
};

const LOC_CHUNK = 500;

function findingPenalty(finding: Finding): number {
    return SEVERITY_WEIGHT[finding.severity] * CONFIDENCE_WEIGHT[finding.confidence];
}

function normalizedCategoryScore(findings: Finding[], sourceLOC: number): number {
    const penalty = findings.reduce((sum, finding) => sum + findingPenalty(finding), 0);
    const normalizer = Math.max(sourceLOC / LOC_CHUNK, 1);
    return Math.max(0, Math.min(10, 10 - penalty / normalizer));
}

export interface ScoringResult {
    overallScore: number;
    categoryScores: Record<string, number>;
    securityScore: number;
}

export function computeScores(findings: Finding[], sourceLOC: number): ScoringResult {
    const categoryScores: Record<string, number> = {};

    for (const category of Object.keys(CATEGORY_WEIGHTS)) {
        const categoryFindings = findings.filter((finding) => finding.category === category);
        categoryScores[category] = Number(normalizedCategoryScore(categoryFindings, sourceLOC).toFixed(1));
    }

    const overallScore = Object.entries(CATEGORY_WEIGHTS).reduce(
        (sum, [category, weight]) => sum + weight * categoryScores[category],
        0
    );

    const securityFindings = findings.filter((finding) => finding.category === 'security');
    const securityScore = Number(normalizedCategoryScore(securityFindings, sourceLOC).toFixed(1));

    return {
        overallScore: Number(overallScore.toFixed(1)),
        categoryScores,
        securityScore
    };
}

export interface Deduction {
    ruleId: string;
    category: string;
    count: number;
    totalPenalty: number;
}

export function summarizeTopDeductions(findings: Finding[], limit = 8): Deduction[] {
    const byRule = new Map<string, Deduction>();

    for (const finding of findings) {
        const existing = byRule.get(finding.ruleId);
        const penalty = findingPenalty(finding);

        if (existing) {
            existing.count += 1;
            existing.totalPenalty += penalty;
        } else {
            byRule.set(finding.ruleId, { ruleId: finding.ruleId, category: finding.category, count: 1, totalPenalty: penalty });
        }
    }

    return [...byRule.values()].sort((a, b) => b.totalPenalty - a.totalPenalty).slice(0, limit);
}
