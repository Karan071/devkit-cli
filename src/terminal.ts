import fs from 'node:fs';
import path from 'node:path';
import type { Severity } from './types';

const colorEnabled = Boolean(process.env.FORCE_COLOR) || (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);

/** Box-drawing and block glyphs, with a plain-ASCII fallback for dumb terminals. */
const ascii = process.env.TERM === 'dumb' || Boolean(process.env.DEVKIT_ASCII);
export const glyph = ascii
    ? { full: '#', empty: '.', tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', dot: '*', bullet: '-', arrow: '->', check: 'ok', warn: '!', rail: '|', sep: '-' }
    : { full: '█', empty: '░', tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', dot: '●', bullet: '•', arrow: '→', check: '✔', warn: '▲', rail: '┃', sep: '─' };

function wrap(open: string, close: string): (text: string) => string {
    return (text: string) => (colorEnabled ? `\x1b[${open}m${text}\x1b[${close}m` : text);
}

export const color = {
    bold: wrap('1', '22'),
    dim: wrap('2', '22'),
    italic: wrap('3', '23'),
    inverse: wrap('7', '27'),
    red: wrap('31', '39'),
    green: wrap('32', '39'),
    yellow: wrap('33', '39'),
    blue: wrap('34', '39'),
    magenta: wrap('35', '39'),
    cyan: wrap('36', '39'),
    gray: wrap('90', '39'),
    white: wrap('37', '39'),
    brightRed: wrap('91', '39'),
    bgRed: wrap('41;97', '49;39'),
    bgYellow: wrap('43;30', '49;39'),
    bgGreen: wrap('42;30', '49;39'),
    bgCyan: wrap('46;30', '49;39'),
    bgGray: wrap('100;97', '49;39')
};

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Printable width of a string, ignoring ANSI escape codes. */
function visibleLength(text: string): number {
    return [...text.replace(ANSI_PATTERN, '')].length;
}

export function terminalWidth(): number {
    const columns = process.stdout.columns || 100;
    return Math.max(60, Math.min(columns, 100));
}

export function severityColor(severity: Severity, text: string): string {
    switch (severity) {
        case 'CRITICAL':
            return color.brightRed(color.bold(text));
        case 'HIGH':
            return color.red(text);
        case 'MEDIUM':
            return color.yellow(text);
        case 'LOW':
            return color.cyan(text);
        default:
            return color.gray(text);
    }
}

export function severityBadge(severity: Severity): string {
    const label = ` ${severity.padEnd(8)}`;
    if (!colorEnabled) return `[${severity}]`.padEnd(10);
    switch (severity) {
        case 'CRITICAL':
        case 'HIGH':
            return color.bgRed(label);
        case 'MEDIUM':
            return color.bgYellow(label);
        case 'LOW':
            return color.bgCyan(label);
        default:
            return color.bgGray(label);
    }
}

export function scoreColor(score: number, text: string): string {
    if (score >= 8) return color.green(text);
    if (score >= 5) return color.yellow(text);
    return color.red(text);
}

export function scoreLabel(score: number): string {
    if (score >= 9) return 'Excellent';
    if (score >= 7) return 'Good';
    if (score >= 5) return 'Needs work';
    if (score >= 3) return 'Poor';
    return 'Critical';
}

export function scoreGrade(score: number): string {
    if (score >= 9) return 'A';
    if (score >= 7) return 'B';
    if (score >= 5) return 'C';
    if (score >= 3) return 'D';
    return 'F';
}

export function renderScoreBar(score: number, width = 28): string {
    const filled = Math.round((Math.max(0, Math.min(10, score)) / 10) * width);
    return scoreColor(score, glyph.full.repeat(filled)) + color.dim(glyph.empty.repeat(width - filled));
}

/** A single horizontal bar split into colored segments, e.g. a severity distribution. */
export function renderStackedBar(segments: Array<{ value: number; paint: (text: string) => string }>, width: number): string {
    const total = segments.reduce((sum, segment) => sum + segment.value, 0);
    if (total === 0) return color.dim(glyph.empty.repeat(width));
    let used = 0;
    return segments
        .map((segment, index) => {
            const isLast = index === segments.length - 1;
            const cells = isLast ? width - used : Math.round((segment.value / total) * width);
            const size = segment.value > 0 ? Math.max(1, Math.min(cells, width - used)) : 0;
            used += size;
            return segment.paint(glyph.full.repeat(size));
        })
        .join('');
}

export function pad(text: string, width: number): string {
    const length = visibleLength(text);
    return length >= width ? text : text + ' '.repeat(width - length);
}

export function padStart(text: string, width: number): string {
    const length = visibleLength(text);
    return length >= width ? text : ' '.repeat(width - length) + text;
}

export function truncateMiddle(text: string, width: number): string {
    if (text.length <= width) return text;
    const keep = width - 1;
    return `${text.slice(0, Math.ceil(keep / 3))}…${text.slice(text.length - Math.floor((keep * 2) / 3))}`;
}

/** A rounded box around pre-rendered lines. */
export function renderBox(content: string[], width: number): string[] {
    const inner = width - 4;
    return [
        color.dim(`${glyph.tl}${glyph.h.repeat(width - 2)}${glyph.tr}`),
        ...content.map((line) => `${color.dim(glyph.v)} ${pad(line, inner)} ${color.dim(glyph.v)}`),
        color.dim(`${glyph.bl}${glyph.h.repeat(width - 2)}${glyph.br}`)
    ];
}

export function sectionHeading(title: string, width: number, detail = ''): string {
    const label = ` ${color.bold(title.toUpperCase())}${detail ? ` ${color.dim(detail)}` : ''} `;
    return `${color.dim(glyph.h.repeat(2))}${label}${color.dim(glyph.h.repeat(Math.max(0, width - visibleLength(label) - 2)))}`;
}

export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function renderCodeFrame(repository: string, relativeFile: string, line: number, column: number, severity: Severity): string[] {
    const absolutePath = path.join(repository, relativeFile);

    let lines: string[];
    try {
        lines = fs.readFileSync(absolutePath, 'utf8').split(/\r\n|\r|\n/);
    } catch {
        return [];
    }

    const startLine = Math.max(1, line - 1);
    const endLine = Math.min(lines.length, line + 1);
    const gutterWidth = String(endLine).length;
    const output: string[] = [];
    const maxWidth = terminalWidth() - gutterWidth - 12;

    const truncate = (text: string): string => (text.length > maxWidth ? `${text.slice(0, maxWidth)}…` : text);

    for (let current = startLine; current <= endLine; current += 1) {
        const rawText = (lines[current - 1] ?? '').replace(/\t/g, '    ');
        const text = truncate(rawText);
        const gutter = padStart(String(current), gutterWidth);
        const marker = current === line ? severityColor(severity, '>') : ' ';

        if (current === line) {
            output.push(`    ${marker} ${color.bold(gutter)} ${color.dim(glyph.v)} ${text}`);
            if (column > 0 && column - 1 < maxWidth) {
                output.push(`      ${' '.repeat(gutterWidth)} ${color.dim(glyph.v)} ${' '.repeat(Math.max(0, column - 1))}${severityColor(severity, '^')}`);
            }
        } else {
            output.push(`    ${marker} ${color.dim(gutter)} ${color.dim(glyph.v)} ${color.dim(text)}`);
        }
    }

    return output;
}

const SPINNER_FRAMES = ascii ? ['-', '\\', '|', '/'] : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface ProgressUpdate {
    step: number;
    totalSteps: number;
    label: string;
    current?: number;
    total?: number;
}

/**
 * Live scan progress on stderr. The scan itself is synchronous, so a timer-driven spinner would
 * never get to draw; instead every progress update redraws the line directly (throttled).
 * Writes nothing when stderr is not a TTY, so piped/CI output stays clean.
 */
export class ProgressRenderer {
    private frame = 0;
    private lastDraw = 0;
    private lastStep = 0;
    private readonly enabled = Boolean(process.stderr.isTTY);
    private readonly startedAt = Date.now();

    update(progress: ProgressUpdate): void {
        if (!this.enabled) return;
        const now = Date.now();
        const isNewStep = progress.step !== this.lastStep;
        if (!isNewStep && now - this.lastDraw < 60) return;
        this.lastDraw = now;
        this.lastStep = progress.step;
        this.frame = (this.frame + 1) % SPINNER_FRAMES.length;

        const width = 20;
        const fraction = (progress.step - 1 + (progress.total ? (progress.current ?? 0) / progress.total : 0)) / progress.totalSteps;
        const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
        const bar = color.cyan(glyph.full.repeat(filled)) + color.dim(glyph.empty.repeat(width - filled));
        const counter = progress.total ? color.dim(` ${progress.current}/${progress.total}`) : '';
        const percent = color.dim(`${String(Math.round(fraction * 100)).padStart(3)}%`);
        const elapsed = color.dim(formatDuration(now - this.startedAt));
        process.stderr.write(`\r\x1b[K${color.cyan(SPINNER_FRAMES[this.frame])} ${bar} ${percent}  ${progress.label}${counter}  ${elapsed}`);
    }

    finish(message: string): void {
        if (!this.enabled) return;
        process.stderr.write(`\r\x1b[K${color.green(glyph.check)} ${message} ${color.dim(`in ${formatDuration(Date.now() - this.startedAt)}`)}\n`);
    }

    fail(): void {
        if (!this.enabled) return;
        process.stderr.write('\r\x1b[K');
    }
}
