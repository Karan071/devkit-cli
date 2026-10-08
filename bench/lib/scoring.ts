import fs from 'node:fs';
import path from 'node:path';

export type Confidence = 'CERTAIN' | 'HIGH' | 'MEDIUM' | 'LOW';
const CONFIDENCE_ORDER: Confidence[] = ['LOW', 'MEDIUM', 'HIGH', 'CERTAIN'];

/** The slice of a scanner finding the benchmark needs. */
export interface BenchFinding {
    ruleId: string;
    severity?: string;
    file: string;
    line: number;
    confidence: Confidence;
}

/** A defect deliberately planted in bench/seeded; the named rule is expected to report it. */
export interface PlantedIssue {
    id: string;
    rule: string;
    file: string;
    /** Line number, or "any" for files that cannot carry a marker comment (package.json). Default: the line holding `planted: <id>`. */
    line?: number | 'any';
    /** Tracking item (e.g. "G1") for a gap the scanner is known to have. A known gap does not fail the gate. */
    issue?: string;
}

/** Clean code that a rule should leave alone; any finding from `rule` there is a false positive. */
export interface Decoy {
    id: string;
    rule: string;
    file: string;
    line?: number | 'any';
    /** Findings at or below this confidence are tolerated (reported, but discounted). */
    tolerate?: Confidence;
    /** Tracking item for a false positive the scanner is known to have. */
    issue?: string;
}

export interface Expectations {
    planted: PlantedIssue[];
    decoys: Decoy[];
}

export interface Label {
    repo: string;
    rule: string;
    file: string;
    line: number;
    verdict: boolean;
    reason: string;
}

export interface RuleScore {
    rule: string;
    /** Findings judged real. */
    truePositives: number;
    /** Findings judged not real. */
    falsePositives: number;
    labeled: number;
    /** Share of labeled findings that were real, in percent; null when nothing is labeled. */
    accuracy: number | null;
}

export interface PlantedResult extends PlantedIssue {
    caught: boolean;
}

export interface Report {
    catchRate: { total: number; caught: number; percent: number };
    planted: PlantedResult[];
    /** Planted issues that are neither caught nor a known gap: these fail the gate. */
    missed: PlantedResult[];
    /** Known gaps that are now caught: the expectation should drop its `issue` tag. */
    resolvedGaps: PlantedResult[];
    /** Decoys currently flagged. */
    flaggedDecoys: Array<Decoy & { findings: number }>;
    /** Decoys tagged as known false positives that are no longer flagged. */
    resolvedDecoys: Decoy[];
    rules: RuleScore[];
    /** Findings from the seeded repo that match neither a planted issue nor a decoy. */
    unlabeledSeeded: number;
    /** Labels that no longer match any finding (the code or the rule changed). */
    staleLabels: number;
}

export interface Baseline {
    rules: Record<string, { accuracy: number; labeled: number }>;
}

export interface GateResult {
    ok: boolean;
    failures: string[];
    warnings: string[];
}

export const LABEL_TARGET = 30;
export const MAX_ACCURACY_DROP = 2;

/** Line (1-based) holding `<kind>: <id>` in the seeded source, which is where its finding is expected. */
export function findMarkerLine(text: string, kind: 'planted' | 'decoy', id: string): number | null {
    const lines = text.split(/\r\n|\r|\n/);
    const marker = new RegExp(`${kind}: ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
    const index = lines.findIndex((line) => marker.test(line));
    return index === -1 ? null : index + 1;
}

export function readExpectations(seededDir: string): { expectations: Expectations; lines: Map<string, number | 'any'> } {
    const expectations = JSON.parse(fs.readFileSync(path.join(seededDir, 'expectations.json'), 'utf8')) as Expectations;
    const lines = new Map<string, number | 'any'>();
    const resolve = (kind: 'planted' | 'decoy', entry: PlantedIssue | Decoy): void => {
        if (entry.line !== undefined) {
            lines.set(`${kind}:${entry.id}`, entry.line);
            return;
        }
        const text = fs.readFileSync(path.join(seededDir, entry.file), 'utf8');
        const line = findMarkerLine(text, kind, entry.id);
        if (line === null) throw new Error(`Seeded ${kind} "${entry.id}": no "${kind}: ${entry.id}" marker in ${entry.file}`);
        lines.set(`${kind}:${entry.id}`, line);
    };
    expectations.planted.forEach((entry) => resolve('planted', entry));
    expectations.decoys.forEach((entry) => resolve('decoy', entry));
    return { expectations, lines };
}

export function parseLabels(content: string, source: string): Label[] {
    const labels: Label[] = [];
    content.split(/\r?\n/).forEach((raw, index) => {
        if (!raw.trim()) return;
        let entry: Record<string, unknown>;
        try {
            entry = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            throw new Error(`${source}:${index + 1}: invalid JSON`);
        }
        // `verdict: null` marks a sampled-but-not-yet-labeled finding.
        if (typeof entry.verdict !== 'boolean') return;
        if (typeof entry.repo !== 'string' || typeof entry.rule !== 'string' || typeof entry.file !== 'string' || typeof entry.line !== 'number') {
            throw new Error(`${source}:${index + 1}: label needs repo, rule, file and line`);
        }
        labels.push({ repo: entry.repo, rule: entry.rule, file: entry.file, line: entry.line, verdict: entry.verdict, reason: typeof entry.reason === 'string' ? entry.reason : '' });
    });
    return labels;
}

export function readLabels(labelsDir: string): Label[] {
    if (!fs.existsSync(labelsDir)) return [];
    return fs.readdirSync(labelsDir)
        .filter((name) => name.endsWith('.jsonl') && !name.endsWith('.todo.jsonl'))
        .sort()
        .flatMap((name) => parseLabels(fs.readFileSync(path.join(labelsDir, name), 'utf8'), path.join(labelsDir, name)));
}

const atLine = (finding: BenchFinding, rule: string, file: string, line: number | 'any'): boolean =>
    finding.ruleId === rule && finding.file === file && (line === 'any' || finding.line === line);

const isTolerated = (finding: BenchFinding, tolerate: Confidence | undefined): boolean =>
    !!tolerate && CONFIDENCE_ORDER.indexOf(finding.confidence) <= CONFIDENCE_ORDER.indexOf(tolerate);

export interface EvaluateInput {
    ruleIds: string[];
    seededFindings: BenchFinding[];
    expectations: Expectations;
    markerLines: Map<string, number | 'any'>;
    /** Findings per corpus repo, keyed by repo name. */
    corpusFindings: Record<string, BenchFinding[]>;
    labels: Label[];
}

export function evaluate(input: EvaluateInput): Report {
    const { seededFindings, expectations, markerLines } = input;
    const tally = new Map<string, { tp: number; fp: number }>();
    const count = (rule: string, real: boolean): void => {
        const entry = tally.get(rule) ?? { tp: 0, fp: 0 };
        if (real) entry.tp += 1;
        else entry.fp += 1;
        tally.set(rule, entry);
    };

    const lineOf = (kind: 'planted' | 'decoy', id: string): number | 'any' => markerLines.get(`${kind}:${id}`) ?? 'any';

    const planted: PlantedResult[] = expectations.planted.map((entry) => ({
        ...entry,
        caught: seededFindings.some((finding) => atLine(finding, entry.rule, entry.file, lineOf('planted', entry.id)))
    }));

    let unlabeledSeeded = 0;
    for (const finding of seededFindings) {
        // Informational findings are shown but never cost points, so they are neither right nor wrong.
        if (finding.severity === 'INFO') continue;
        const isPlanted = expectations.planted.some((entry) => atLine(finding, entry.rule, entry.file, lineOf('planted', entry.id)));
        const decoy = expectations.decoys.find((entry) => atLine(finding, entry.rule, entry.file, lineOf('decoy', entry.id)));
        if (isPlanted) count(finding.ruleId, true);
        else if (decoy && !isTolerated(finding, decoy.tolerate)) count(finding.ruleId, false);
        else if (!decoy) unlabeledSeeded += 1;
    }

    const flaggedDecoys = expectations.decoys
        .map((entry) => ({
            ...entry,
            findings: seededFindings.filter((finding) => finding.severity !== 'INFO' && atLine(finding, entry.rule, entry.file, lineOf('decoy', entry.id)) && !isTolerated(finding, entry.tolerate)).length
        }))
        .filter((entry) => entry.findings > 0);

    const labelIndex = new Map(input.labels.map((label) => [`${label.repo}|${label.rule}|${label.file}|${label.line}`, label]));
    const usedLabels = new Set<string>();
    for (const [repo, findings] of Object.entries(input.corpusFindings)) {
        for (const finding of findings) {
            const key = `${repo}|${finding.ruleId}|${finding.file}|${finding.line}`;
            const label = labelIndex.get(key);
            if (!label) continue;
            usedLabels.add(key);
            if (finding.severity !== 'INFO') count(finding.ruleId, label.verdict);
        }
    }
    // A label only goes stale when its repo was scanned; labels for repos without results are simply not applied.
    const staleLabels = input.labels.filter((label) => label.repo in input.corpusFindings && !usedLabels.has(`${label.repo}|${label.rule}|${label.file}|${label.line}`)).length;

    const ruleIds = new Set([...input.ruleIds, ...tally.keys()]);
    const rules: RuleScore[] = [...ruleIds].sort().map((rule) => {
        const { tp, fp } = tally.get(rule) ?? { tp: 0, fp: 0 };
        const labeled = tp + fp;
        return { rule, truePositives: tp, falsePositives: fp, labeled, accuracy: labeled === 0 ? null : round1((tp / labeled) * 100) };
    });

    const caught = planted.filter((entry) => entry.caught).length;
    return {
        catchRate: { total: planted.length, caught, percent: planted.length === 0 ? 100 : round1((caught / planted.length) * 100) },
        planted,
        missed: planted.filter((entry) => !entry.caught && !entry.issue),
        resolvedGaps: planted.filter((entry) => entry.caught && entry.issue),
        flaggedDecoys,
        resolvedDecoys: expectations.decoys.filter((entry) => entry.issue && !flaggedDecoys.some((flagged) => flagged.id === entry.id)),
        rules,
        unlabeledSeeded,
        staleLabels
    };
}

function round1(value: number): number {
    return Math.round(value * 10) / 10;
}

/** The CI gate: a missed planted issue, or a rule whose accuracy fell more than MAX_ACCURACY_DROP points. */
export function checkGate(report: Report, baseline: Baseline | null): GateResult {
    const failures: string[] = [];
    const warnings: string[] = [];

    for (const entry of report.missed) {
        failures.push(`Planted issue "${entry.id}" (${entry.rule} in ${entry.file}) was not reported.`);
    }

    for (const score of report.rules) {
        const previous = baseline?.rules[score.rule];
        if (score.accuracy === null) continue;
        if (!previous) {
            warnings.push(`${score.rule} has no baseline accuracy yet (${score.accuracy}%); run with --update-baseline to record it.`);
            continue;
        }
        if (previous.accuracy - score.accuracy > MAX_ACCURACY_DROP) {
            failures.push(`${score.rule} accuracy fell from ${previous.accuracy}% to ${score.accuracy}% (more than ${MAX_ACCURACY_DROP} points).`);
        }
    }

    for (const entry of report.resolvedGaps) {
        warnings.push(`Known gap "${entry.id}" (${entry.issue}) is now caught: remove its "issue" tag from expectations.json.`);
    }
    for (const entry of report.resolvedDecoys) {
        warnings.push(`Known false positive "${entry.id}" (${entry.issue}) is gone: remove its "issue" tag from expectations.json.`);
    }
    if (report.staleLabels > 0) {
        warnings.push(`${report.staleLabels} label(s) no longer match a finding; re-sample or remove them.`);
    }

    return { ok: failures.length === 0, failures, warnings };
}

export function toBaseline(report: Report): Baseline {
    const rules: Baseline['rules'] = {};
    for (const score of report.rules) {
        if (score.accuracy !== null) rules[score.rule] = { accuracy: score.accuracy, labeled: score.labeled };
    }
    return { rules };
}

export function formatMarkdown(report: Report, baseline: Baseline | null): string {
    const out: string[] = [];
    out.push('## Planted-issue catch rate', '');
    out.push(`**${report.catchRate.caught}/${report.catchRate.total}** planted issues reported (${report.catchRate.percent}%).`, '');
    out.push('| Planted issue | Rule | Status | Tracking |', '| --- | --- | --- | --- |');
    for (const entry of report.planted) {
        out.push(`| ${entry.id} | ${entry.rule} | ${entry.caught ? 'caught' : entry.issue ? 'known gap' : '**MISSED**'} | ${entry.issue ?? ''} |`);
    }

    out.push('', '## Per-rule accuracy', '');
    out.push(`Accuracy is the share of labeled findings that were real. Each rule needs ${LABEL_TARGET}+ labels for the figure to be reliable.`, '');
    out.push('| Rule | Labeled | Real | False | Accuracy | Baseline |', '| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const score of report.rules) {
        const previous = baseline?.rules[score.rule]?.accuracy;
        out.push(`| ${score.rule} | ${score.labeled}${score.labeled > 0 && score.labeled < LABEL_TARGET ? ' (low)' : ''} | ${score.truePositives} | ${score.falsePositives} | ${score.accuracy === null ? 'n/a' : `${score.accuracy}%`} | ${previous === undefined ? 'n/a' : `${previous}%`} |`);
    }

    if (report.flaggedDecoys.length > 0) {
        out.push('', '## Decoys flagged (false positives on known-clean code)', '');
        for (const entry of report.flaggedDecoys) out.push(`- ${entry.id} (${entry.rule}, ${entry.file})${entry.issue ? ` - tracked as ${entry.issue}` : ''}`);
    }
    out.push('', `Seeded-repo findings matching neither a planted issue nor a decoy: ${report.unlabeledSeeded} (not scored).`);
    return `${out.join('\n')}\n`;
}
