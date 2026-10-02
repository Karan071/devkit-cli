import { isTestFile } from './discovery';
import type { Confidence, Finding, Severity } from './types';

export const CATEGORY_WEIGHTS: Record<string, number> = {
    deadCode: 0.15,
    dependencies: 0.1,
    complexity: 0.15,
    duplication: 0.1,
    redundantLogic: 0.05,
    errorHandling: 0.1,
    typescript: 0.1,
    architecture: 0.05,
    hygiene: 0.05,
    security: 0.15
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

/** Findings in tests still matter, but less than the same problem in shipped code. */
const TEST_FILE_WEIGHT = 0.5;

/** A credible leaked secret or injection sink caps the overall score, however clean the rest is. */
export const SECURITY_CAP = 6.9;

function findingPenalty(finding: Finding): number {
    const base = SEVERITY_WEIGHT[finding.severity] * CONFIDENCE_WEIGHT[finding.confidence];
    return isTestFile(finding.file) ? base * TEST_FILE_WEIGHT : base;
}

/**
 * Quality categories are scored by density (penalty per 500 LOC), so a large codebase is not
 * punished for its size. Security tolerance grows only with the square root of size and is capped
 * at 3x: one leaked key is just as serious in a 50k-line repository as in a 500-line one.
 */
function normalizedCategoryScore(findings: Finding[], loc: number, category: string): number {
    const penalty = findings.reduce((sum, finding) => sum + findingPenalty(finding), 0);
    const chunks = Math.max(loc / LOC_CHUNK, 1);
    const normalizer = category === 'security' ? Math.min(Math.sqrt(chunks), 3) : chunks;
    return Math.max(0, Math.min(10, 10 - penalty / normalizer));
}

function hasCredibleSecurityIssue(findings: Finding[]): boolean {
    return findings.some(
        (finding) =>
            finding.category === 'security' &&
            (finding.severity === 'HIGH' || finding.severity === 'CRITICAL') &&
            (finding.confidence === 'HIGH' || finding.confidence === 'CERTAIN') &&
            !isTestFile(finding.file)
    );
}

export interface ScoringResult {
    overallScore: number;
    categoryScores: Record<string, number>;
    securityScore: number;
    /** True when the overall score was capped because of a credible security finding. */
    securityCapped: boolean;
}

export interface ScoringOptions {
    /** Architecture can only be scored when layers are configured; otherwise it is excluded from the blend. */
    architectureConfigured?: boolean;
}

export function computeScores(findings: Finding[], loc: number, options: ScoringOptions = {}): ScoringResult {
    const architectureConfigured = options.architectureConfigured ?? true;
    const categories = Object.keys(CATEGORY_WEIGHTS).filter((category) => category !== 'architecture' || architectureConfigured);
    const categoryScores: Record<string, number> = {};

    for (const category of categories) {
        const categoryFindings = findings.filter((finding) => finding.category === category);
        categoryScores[category] = Number(normalizedCategoryScore(categoryFindings, loc, category).toFixed(1));
    }

    const totalWeight = categories.reduce((sum, category) => sum + CATEGORY_WEIGHTS[category], 0);
    const weighted = categories.reduce((sum, category) => sum + CATEGORY_WEIGHTS[category] * categoryScores[category], 0) / totalWeight;

    const securityCapped = hasCredibleSecurityIssue(findings) && weighted > SECURITY_CAP;
    const overallScore = securityCapped ? SECURITY_CAP : weighted;

    return {
        overallScore: Number(overallScore.toFixed(1)),
        categoryScores,
        securityScore: categoryScores.security,
        securityCapped
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

export interface FileHotspot {
    file: string;
    count: number;
    penalty: number;
    worst: Severity;
}

/** Files ranked by total penalty: where fixing things moves the score the most. */
export function summarizeHotspots(findings: Finding[], limit = 5): FileHotspot[] {
    const rank: Record<Severity, number> = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
    const byFile = new Map<string, FileHotspot>();
    for (const finding of findings) {
        const entry = byFile.get(finding.file) ?? { file: finding.file, count: 0, penalty: 0, worst: 'INFO' as Severity };
        entry.count += 1;
        entry.penalty += findingPenalty(finding);
        if (rank[finding.severity] > rank[entry.worst]) entry.worst = finding.severity;
        byFile.set(finding.file, entry);
    }
    return [...byFile.values()].sort((a, b) => b.penalty - a.penalty).slice(0, limit);
}
