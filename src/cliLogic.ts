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

export function filterFindings(findings: Finding[], filters: ScanFilters): Finding[] {
    return findings.filter((finding) => {
        if (filters.category && finding.category.toLowerCase() !== filters.category.toLowerCase()) return false;
        if (filters.severity && finding.severity.toLowerCase() !== filters.severity.toLowerCase()) return false;
        return true;
    });
}

export function isKnownSeverity(value: string): value is Severity {
    return Object.prototype.hasOwnProperty.call(SEVERITY_RANK, value.toUpperCase());
}

export function determineExitFailure(summary: ScanSummary, gates: ScanGates): boolean {
    if (gates.minScore !== undefined && summary.score < Number(gates.minScore)) return true;
    if (gates.failOn !== undefined) {
        const threshold = gates.failOn.toUpperCase() as Severity;
        if (!isKnownSeverity(gates.failOn)) return true;
        if (summary.findings.some((finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[threshold])) return true;
    }
    return false;
}
