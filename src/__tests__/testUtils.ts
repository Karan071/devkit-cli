import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeFixture(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-test-'));

    if (!files['package.json']) {
        files = { ...files, 'package.json': JSON.stringify({ name: 'fixture', version: '0.0.0' }) };
    }

    for (const [relativePath, content] of Object.entries(files)) {
        const fullPath = path.join(dir, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
    }

    return dir;
}

export function cleanupFixture(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

export function findingsFor<T extends { ruleId: string }>(findings: T[], ruleId: string): T[] {
    return findings.filter((finding) => finding.ruleId === ruleId);
}
