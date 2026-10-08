import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Finding } from './types';
import { buildFinding } from './finding';

export const ADAPTER_NAMES = ['gitleaks', 'knip'] as const;
export type AdapterName = (typeof ADAPTER_NAMES)[number];

export function parseAdapterList(value: string): AdapterName[] {
    const names = value.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
    const unknown = names.filter((name) => !(ADAPTER_NAMES as readonly string[]).includes(name));
    if (unknown.length > 0) throw new Error(`Unknown tool "${unknown[0]}" for --with. Supported: ${ADAPTER_NAMES.join(', ')}`);
    return [...new Set(names)] as AdapterName[];
}

export interface AdapterOutcome {
    findings: Finding[];
    /** One line per tool that could not run or whose output could not be read: shown as a scan warning. */
    notes: string[];
}

export interface AdapterOptions {
    /** Extra directories searched for the tool first (the project's node_modules/.bin is always added). */
    pathDirs?: string[];
}

interface RunResult {
    stdout: string;
    missing: boolean;
}

function run(command: string, args: string[], cwd: string, options: AdapterOptions): RunResult {
    const searchPath = [...(options.pathDirs ?? []), path.join(cwd, 'node_modules', '.bin'), process.env.PATH ?? ''].join(path.delimiter);
    try {
        return { stdout: execFileSync(command, args, { cwd, env: { ...process.env, PATH: searchPath }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }), missing: false };
    } catch (error) {
        const failure = error as NodeJS.ErrnoException & { stdout?: string | Buffer };
        if (failure.code === 'ENOENT') return { stdout: '', missing: true };
        // Both tools exit non-zero when they find something; the report is still on stdout.
        return { stdout: failure.stdout?.toString() ?? '', missing: false };
    }
}

/** A path relative to the project, also when the tool reports real paths and the project was given through a symlink (/var -> /private/var). */
function relativeTo(root: string, file: string): string {
    if (!path.isAbsolute(file)) return file.replace(/\\/g, '/');
    let relative = path.relative(root, file);
    if (relative.startsWith('..')) {
        try {
            relative = path.relative(fs.realpathSync(root), file);
        } catch {
            // Keep the first answer: the project root is not resolvable.
        }
    }
    return relative.replace(/\\/g, '/');
}

interface GitleaksLeak {
    RuleID?: string;
    Description?: string;
    File?: string;
    StartLine?: number;
    StartColumn?: number;
}

/** gitleaks: every leak it reports is a HIGH-severity secret. Matched text is never copied into a finding. */
function runGitleaks(root: string, options: AdapterOptions): { findings: Finding[]; note?: string } {
    const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-gitleaks-')), 'report.json');
    try {
        const result = run('gitleaks', ['detect', '--no-git', '--source', root, '--report-format', 'json', '--report-path', report, '--no-banner', '--exit-code', '0'], root, options);
        if (result.missing) return { findings: [], note: 'gitleaks was requested with --with but is not installed; skipped.' };
        const text = fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : '[]';
        let leaks: GitleaksLeak[];
        try {
            leaks = JSON.parse(text || '[]') as GitleaksLeak[];
        } catch {
            return { findings: [], note: 'gitleaks produced a report that could not be read; skipped.' };
        }
        return {
            findings: (Array.isArray(leaks) ? leaks : []).filter((leak) => leak.File).map((leak) => buildFinding({
                ruleId: `GITLEAKS:${leak.RuleID ?? 'secret'}`, category: 'security', severity: 'HIGH', confidence: 'HIGH',
                file: relativeTo(root, leak.File!), line: leak.StartLine ?? 1, column: leak.StartColumn ?? 1,
                message: `Potential secret (gitleaks: ${leak.RuleID ?? 'secret'})`,
                description: leak.Description ?? 'gitleaks reported a secret at this location.',
                evidence: `gitleaks ${leak.RuleID ?? 'secret'} [redacted]`,
                suggestion: 'Move sensitive values to environment variables or secure secret storage, and rotate the credential.', fixAvailable: false
            })),
            note: undefined
        };
    } finally {
        fs.rmSync(path.dirname(report), { recursive: true, force: true });
    }
}

interface KnipItem { name?: string; line?: number; col?: number }
interface KnipIssue {
    file?: string;
    dependencies?: KnipItem[]; devDependencies?: KnipItem[]; optionalPeerDependencies?: KnipItem[];
    unlisted?: KnipItem[]; unresolved?: KnipItem[]; binaries?: KnipItem[];
    exports?: KnipItem[]; types?: KnipItem[];
}
interface KnipReport { files?: string[]; issues?: KnipIssue[] }

/** knip's JSON reporter (v5): unused files, exports, types and dependencies, unlisted and unresolved imports. */
function runKnip(root: string, options: AdapterOptions): { findings: Finding[]; note?: string } {
    const result = run('knip', ['--reporter', 'json', '--no-progress'], root, options);
    if (result.missing) return { findings: [], note: 'knip was requested with --with but is not installed; skipped.' };
    let report: KnipReport;
    try {
        report = JSON.parse(result.stdout || '{}') as KnipReport;
    } catch {
        return { findings: [], note: 'knip did not print JSON; skipped. Check that your knip version supports --reporter json.' };
    }

    const findings: Finding[] = [];
    const add = (kind: string, category: string, title: string, file: string, item: KnipItem | undefined, severity: Finding['severity']): void => {
        findings.push(buildFinding({
            ruleId: `KNIP:${kind}`, category, severity, confidence: 'HIGH', file: relativeTo(root, file), line: item?.line ?? 1, column: item?.col ?? 1,
            message: item?.name ? `${title}: ${item.name}` : title, description: `knip reports: ${title.toLowerCase()}${item?.name ? ` "${item.name}"` : ''}.`,
            evidence: item?.name ?? file, suggestion: 'Remove it, or add it to the knip configuration if it is used in a way knip cannot see.', fixAvailable: false
        }));
    };

    for (const file of report.files ?? []) add('files', 'deadCode', 'Unused file', file, undefined, 'MEDIUM');
    for (const issue of report.issues ?? []) {
        const file = issue.file ?? 'package.json';
        for (const item of issue.exports ?? []) add('exports', 'deadCode', 'Unused export', file, item, 'MEDIUM');
        for (const item of issue.types ?? []) add('types', 'deadCode', 'Unused exported type', file, item, 'LOW');
        for (const item of [...(issue.dependencies ?? []), ...(issue.devDependencies ?? []), ...(issue.optionalPeerDependencies ?? [])]) add('dependencies', 'dependencies', 'Unused dependency', file, item, 'MEDIUM');
        for (const item of issue.unlisted ?? []) add('unlisted', 'dependencies', 'Unlisted dependency', file, item, 'HIGH');
        for (const item of issue.unresolved ?? []) add('unresolved', 'dependencies', 'Unresolved import', file, item, 'MEDIUM');
    }
    return { findings };
}

/**
 * Runs the requested external tools and returns their findings in DevKit's shape. A tool that is missing or
 * unreadable is reported in `notes`, never silently dropped and never fatal: the built-in scan still completes.
 * A gitleaks hit that lands on a line the built-in secret scan already reported is a confirmation, not a second
 * finding, so it is merged into the existing one (which becomes HIGH confidence).
 */
export function runAdapters(root: string, names: AdapterName[], existing: Finding[], options: AdapterOptions = {}): AdapterOutcome {
    const findings: Finding[] = [];
    const notes: string[] = [];
    for (const name of names) {
        const outcome = name === 'gitleaks' ? runGitleaks(root, options) : runKnip(root, options);
        if (outcome.note) notes.push(outcome.note);
        for (const finding of outcome.findings) {
            const builtIn = name === 'gitleaks' ? existing.find((other) => other.ruleId === 'SEC001' && other.file === finding.file && other.line === finding.line) : undefined;
            if (builtIn) {
                if (builtIn.confidence === 'LOW' || builtIn.confidence === 'MEDIUM') builtIn.confidence = 'HIGH';
                continue;
            }
            findings.push(finding);
        }
    }
    return { findings, notes };
}
