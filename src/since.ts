import { execFileSync } from 'node:child_process';
import type { Finding } from './types';

/** Lines added or changed per file (1-based, inclusive ranges), or `all` for a file that is new to the repository. */
export type ChangedLines = Map<string, Array<[number, number]> | 'all'>;

function git(projectRoot: string, args: string[]): string {
    try {
        return execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
    } catch (error) {
        const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim();
        throw new Error(stderr || `git ${args[0]} failed`);
    }
}

/** Parses `git diff --unified=0` output into the new-side line ranges of every changed file. */
export function parseChangedLines(diff: string): ChangedLines {
    const changed: ChangedLines = new Map();
    let file: string | null = null;
    for (const line of diff.split('\n')) {
        if (line.startsWith('+++ ')) {
            // `+++ b/path` for a change, `+++ /dev/null` for a deletion.
            file = line.startsWith('+++ b/') ? line.slice('+++ b/'.length) : null;
            if (file && !changed.has(file)) changed.set(file, []);
            continue;
        }
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (!hunk || !file) continue;
        const start = Number(hunk[1]);
        const length = hunk[2] === undefined ? 1 : Number(hunk[2]);
        // A length of 0 is a pure deletion: nothing new to report on.
        if (length === 0) continue;
        const ranges = changed.get(file);
        if (Array.isArray(ranges)) ranges.push([start, start + length - 1]);
    }
    return changed;
}

/**
 * What changed between `ref` and the working tree, relative to the scanned directory. Files that git has not
 * seen yet count in full, since every line of them is new.
 */
export function changedLinesSince(projectRoot: string, ref: string): ChangedLines {
    // Fail with git's own message for a bad ref instead of reporting "no changes".
    git(projectRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const changed = parseChangedLines(git(projectRoot, ['diff', '--unified=0', '--no-color', '--no-renames', '--relative', ref, '--']));
    for (const file of git(projectRoot, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) changed.set(file, 'all');
    return changed;
}

/** Findings on lines that changed. A finding that anchors to a whole file (line 1) counts when the file is new. */
export function filterToChanged(findings: Finding[], changed: ChangedLines): Finding[] {
    return findings.filter((finding) => {
        const ranges = changed.get(finding.file);
        if (!ranges) return false;
        if (ranges === 'all') return true;
        return ranges.some(([start, end]) => finding.line >= start && finding.line <= end);
    });
}
