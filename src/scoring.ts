import { isTestFile } from './discovery';
import type { Confidence, Finding, ScoreDrain, Severity } from './types';

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
    // Informational findings are shown but never cost points.
    INFO: 0
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
 * One rule's cost in category points before it stops growing linearly. Past the knee, extra findings of the same
 * rule add only logarithmically, so one noisy rule (500 `any`s) cannot flatten a whole category by itself while a
 * handful of findings still count in full.
 */
const RULE_COST_KNEE = 2;

export function dampenRuleCost(points: number): number {
    return points <= RULE_COST_KNEE ? points : RULE_COST_KNEE + Math.log(points - RULE_COST_KNEE + 1);
}

interface CategoryScore {
    score: number;
    /** Points each rule took off this category. */
    costByRule: Map<string, number>;
}

/**
 * Quality categories are scored by density (penalty per 500 LOC), so a large codebase is not
 * punished for its size. Security tolerance grows only with the square root of size and is capped
 * at 3x: one leaked key is just as serious in a 50k-line repository as in a 500-line one.
 */
function scoreCategory(findings: Finding[], loc: number, category: string): CategoryScore {
    const chunks = Math.max(loc / LOC_CHUNK, 1);
    const normalizer = category === 'security' ? Math.min(Math.sqrt(chunks), 3) : chunks;

    const penaltyByRule = new Map<string, number>();
    for (const finding of findings) penaltyByRule.set(finding.ruleId, (penaltyByRule.get(finding.ruleId) ?? 0) + findingPenalty(finding));

    const costByRule = new Map<string, number>();
    let total = 0;
    for (const [rule, penalty] of penaltyByRule) {
        const cost = dampenRuleCost(penalty / normalizer);
        costByRule.set(rule, cost);
        total += cost;
    }
    // The score bottoms out at 0; shrink every rule's share equally when their sum overshoots.
    const scale = total > 10 ? 10 / total : 1;
    for (const [rule, cost] of costByRule) costByRule.set(rule, cost * scale);
    return { score: Math.max(0, Math.min(10, 10 - total)), costByRule };
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
    /** Rules ranked by how many overall points they cost; INFO-only rules cost nothing and are left out. */
    drains: ScoreDrain[];
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
    const totalWeight = categories.reduce((sum, category) => sum + CATEGORY_WEIGHTS[category], 0);
    const drains: ScoreDrain[] = [];

    for (const category of categories) {
        const categoryFindings = findings.filter((finding) => finding.category === category);
        const scored = scoreCategory(categoryFindings, loc, category);
        categoryScores[category] = Number(scored.score.toFixed(1));
        for (const [ruleId, cost] of scored.costByRule) {
            const pointsLost = (CATEGORY_WEIGHTS[category] / totalWeight) * cost;
            if (pointsLost > 0) drains.push({ ruleId, category, count: categoryFindings.filter((finding) => finding.ruleId === ruleId).length, pointsLost });
        }
    }
    drains.sort((a, b) => b.pointsLost - a.pointsLost);

    const weighted = categories.reduce((sum, category) => sum + CATEGORY_WEIGHTS[category] * categoryScores[category], 0) / totalWeight;

    const securityCapped = hasCredibleSecurityIssue(findings) && weighted > SECURITY_CAP;
    const overallScore = securityCapped ? SECURITY_CAP : weighted;

    return {
        overallScore: Number(overallScore.toFixed(1)),
        drains,
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
