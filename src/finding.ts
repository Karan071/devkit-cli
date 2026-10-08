import crypto from 'node:crypto';
import type { Confidence, Finding, Severity } from './types';

/**
 * A stable identity for a finding: rule, file and the normalized offending code, but not the line number. Adding
 * a function above it, or reformatting, keeps the same id, so baselines and suppressions survive refactors.
 */
export function fingerprint(ruleId: string, file: string, evidence: string): string {
    const normalized = evidence.replace(/\s+/g, ' ').trim().slice(0, 200);
    return `${ruleId}-${crypto.createHash('sha256').update(`${ruleId}\0${file}\0${normalized}`).digest('hex').slice(0, 12)}`;
}

/** Gives identical fingerprints within one file a numeric suffix, in source order, so every id is unique. */
export function disambiguateFingerprints(findings: Finding[]): void {
    const seen = new Map<string, number>();
    for (const finding of [...findings].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)) {
        const count = (seen.get(finding.id) ?? 0) + 1;
        seen.set(finding.id, count);
        if (count > 1) finding.id = `${finding.id}-${count}`;
    }
}

export function buildFinding(params: {
    ruleId: string;
    category: string;
    severity: Severity;
    confidence: Confidence;
    file: string;
    line: number;
    column: number;
    message: string;
    description: string;
    evidence: string;
    suggestion: string;
    fixAvailable?: boolean;
}): Finding {
    return {
        id: fingerprint(params.ruleId, params.file, params.evidence),
        ruleId: params.ruleId,
        category: params.category,
        severity: params.severity,
        confidence: params.confidence,
        file: params.file,
        line: params.line,
        column: params.column,
        message: params.message,
        description: params.description,
        evidence: params.evidence,
        suggestion: params.suggestion,
        fixAvailable: params.fixAvailable ?? false
    };
}
