import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SEEDED_DIR = path.resolve(__dirname, '..', 'seeded');

/**
 * Provider-shaped credentials are assembled from fragments, so the literal tokens never appear in the
 * repository (secret scanners and push protection would otherwise reject the benchmark itself).
 * Seeded sources carry `@@NAME@@` placeholders that are replaced when the repo is materialized.
 */
const SECRETS: Record<string, string> = {
    AWS_ACCESS_KEY: ['AKIA', 'Z7Q3M9X2', 'K5L8P4T6'].join(''),
    STRIPE_SECRET_KEY: ['sk_', 'live_', 'Tq8Vz3Lm9Xc2Kd7Rp4Wn5Yb'].join(''),
    GITHUB_TOKEN: ['ghp_', 'Rk3Vx9Qm2Lz8Tc5Wd7Nb4Yp6', 'Hj1Fs0AaBb'].join(''),
    DB_PASSWORD: ['Sup3rS3cr3t!', 'Passw0rd2024'].join('')
};

export function fillPlaceholders(text: string): string {
    return text.replace(/@@([A-Z_]+)@@/g, (match, name: string) => SECRETS[name] ?? match);
}

function copyTree(from: string, to: string): void {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const source = path.join(from, entry.name);
        const target = path.join(to, entry.name);
        if (entry.isDirectory()) copyTree(source, target);
        else if (entry.name !== 'expectations.json') fs.writeFileSync(target, fillPlaceholders(fs.readFileSync(source, 'utf8')));
    }
}

/** Copies the seeded repo into a fresh temp directory with credentials filled in. Caller removes it. */
export function materializeSeeded(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-bench-seeded-'));
    copyTree(SEEDED_DIR, dir);
    return dir;
}
