import type { BenchFinding } from './scoring';

/** mulberry32: a tiny deterministic PRNG, so the same results always yield the same sample. */
function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hash(text: string): number {
    let value = 2166136261;
    for (const character of text) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
    return value >>> 0;
}

/** Up to `perRule` findings per rule, chosen by a shuffle seeded from the rule id. Output is sorted for stable diffs. */
export function sampleFindings(findings: BenchFinding[], perRule: number): BenchFinding[] {
    const byRule = new Map<string, BenchFinding[]>();
    for (const finding of findings) byRule.set(finding.ruleId, [...(byRule.get(finding.ruleId) ?? []), finding]);

    const picked: BenchFinding[] = [];
    for (const [rule, group] of [...byRule.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const ordered = [...group].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
        const next = random(hash(rule));
        for (let i = ordered.length - 1; i > 0; i -= 1) {
            const j = Math.floor(next() * (i + 1));
            [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
        }
        picked.push(...ordered.slice(0, perRule).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line));
    }
    return picked;
}
