import fs from 'node:fs';
import path from 'node:path';
import type { Severity } from './types';

const colorEnabled = Boolean(process.env.FORCE_COLOR) || (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);

function wrap(open: string, close: string): (text: string) => string {
    return (text: string) => (colorEnabled ? `\x1b[${open}m${text}\x1b[${close}m` : text);
}

export const color = {
    bold: wrap('1', '22'),
    dim: wrap('2', '22'),
    red: wrap('31', '39'),
    green: wrap('32', '39'),
    yellow: wrap('33', '39'),
    blue: wrap('34', '39'),
    magenta: wrap('35', '39'),
    cyan: wrap('36', '39'),
    gray: wrap('90', '39'),
    white: wrap('37', '39')
};

export function severityColor(severity: Severity, text: string): string {
    switch (severity) {
        case 'CRITICAL':
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

export function scoreColor(score: number, text: string): string {
    if (score >= 8) return color.green(text);
    if (score >= 5) return color.yellow(text);
    return color.red(text);
}

export function scoreLabel(score: number): string {
    if (score >= 9) return 'Excellent';
    if (score >= 7) return 'Good';
    if (score >= 5) return 'Needs work';
    return 'Poor';
}

export function renderScoreBar(score: number, width = 28): string {
    const filled = Math.round((Math.max(0, Math.min(10, score)) / 10) * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    return scoreColor(score, bar);
}

export function pad(text: string, width: number): string {
    return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

export function padStart(text: string, width: number): string {
    return text.length >= width ? text : ' '.repeat(width - text.length) + text;
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
    const maxWidth = 100;

    const truncate = (text: string): string => (text.length > maxWidth ? `${text.slice(0, maxWidth)}…` : text);

    for (let current = startLine; current <= endLine; current += 1) {
        const rawText = lines[current - 1] ?? '';
        const text = truncate(rawText);
        const gutter = padStart(String(current), gutterWidth);
        const marker = current === line ? severityColor(severity, '>') : ' ';

        if (current === line) {
            output.push(`  ${marker} ${color.bold(gutter)} ${color.dim('|')} ${text}`);
            if (column > 0 && column - 1 < maxWidth) {
                output.push(`  ${' '.repeat(gutterWidth + 2)} ${color.dim('|')} ${' '.repeat(Math.max(0, column - 1))}${severityColor(severity, '^')}`);
            }
        } else {
            output.push(`  ${marker} ${color.dim(gutter)} ${color.dim('|')} ${color.dim(text)}`);
        }
    }

    return output;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Spinner {
    private frameIndex = 0;
    private timer: NodeJS.Timeout | undefined;
    private readonly text: string;

    constructor(text: string) {
        this.text = text;
    }

    start(): void {
        // Written to stderr so it never pollutes piped/redirected stdout (--format json, etc.).
        if (!process.stderr.isTTY) {
            process.stderr.write(`${this.text}\n`);
            return;
        }

        this.timer = setInterval(() => {
            process.stderr.write(`\r${color.cyan(SPINNER_FRAMES[this.frameIndex])} ${this.text}`);
            this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
        }, 80);
    }

    stop(): void {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = undefined;
        process.stderr.write('\r\x1b[K');
    }
}

export function waitForNextTick(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}
