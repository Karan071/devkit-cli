import type { Finding, ScanSummary, Severity } from './types';

const SEVERITY_RANK: Record<Severity, number> = {
    INFO: 0,
    LOW: 1,
    MEDIUM: 2,
    HIGH: 3,
    CRITICAL: 4
};

export interface ScanFilters {
    category?: string;
    severity?: string;
}

export interface ScanGates {
    minScore?: string;
    failOn?: string;
}

/** `dead-code`, `Dead Code`, `dead_code` and `deadCode` all name the same category. */
function normalizeCategory(value: string): string {
    return value.toLowerCase().replace(/[^a-z]/g, '');
}

const CATEGORY_ALIASES: Record<string, string> = {
    typesafety: 'typescript',
    types: 'typescript',
    redundancy: 'redundantlogic',
    redundant: 'redundantlogic',
    deps: 'dependencies',
    dead: 'deadcode',
    errors: 'errorhandling',
    arch: 'architecture'
};

export function filterFindings(findings: Finding[], filters: ScanFilters): Finding[] {
    const category = filters.category ? normalizeCategory(filters.category) : undefined;
    const wantedCategory = category ? (CATEGORY_ALIASES[category] ?? category) : undefined;
    return findings.filter((finding) => {
        if (wantedCategory && normalizeCategory(finding.category) !== wantedCategory) return false;
        if (filters.severity && finding.severity.toLowerCase() !== filters.severity.toLowerCase()) return false;
        return true;
    });
}

export function isKnownSeverity(value: string): value is Severity {
    return Object.prototype.hasOwnProperty.call(SEVERITY_RANK, value.toUpperCase());
}

/** Returns an error message for invalid gate options, or null when they are usable. */
export function validateGates(gates: ScanGates): string | null {
    if (gates.minScore !== undefined) {
        const value = Number(gates.minScore);
        if (gates.minScore.trim() === '' || !Number.isFinite(value) || value < 0 || value > 10) {
            return `--min-score must be a number between 0 and 10 (got "${gates.minScore}")`;
        }
    }
    if (gates.failOn !== undefined && !isKnownSeverity(gates.failOn)) {
        return `--fail-on must be one of ${Object.keys(SEVERITY_RANK).join(', ').toLowerCase()} (got "${gates.failOn}")`;
    }
    return null;
}

export function determineExitFailure(summary: ScanSummary, gates: ScanGates): boolean {
    if (validateGates(gates)) return true;
    if (gates.minScore !== undefined) {
        // A score computed from zero analyzed files is meaningless; never let it pass a quality gate.
        if (summary.coverage && summary.coverage.analyzedFiles === 0) return true;
        if (summary.score < Number(gates.minScore)) return true;
    }
    if (gates.failOn !== undefined) {
        const threshold = gates.failOn.toUpperCase() as Severity;
        if (summary.findings.some((finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[threshold])) return true;
    }
    return false;
}
