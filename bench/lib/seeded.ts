import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { githubTokenChecksum } from '../../src/rules/secretPatterns';

export const SEEDED_DIR = path.resolve(__dirname, '..', 'seeded');

/**
 * Provider-shaped credentials are assembled from fragments, so the literal tokens never appear in the
 * repository (secret scanners and push protection would otherwise reject the benchmark itself).
 * Seeded sources carry `@@NAME@@` placeholders that are replaced when the repo is materialized.
 */
const GITHUB_ENTROPY = 'Rk3Vx9Qm2Lz8Tc5Wd7Nb4Yp6Hj1Fs0';

const SECRETS: Record<string, string> = {
    AWS_ACCESS_KEY: ['AKIA', 'Z7Q3M9X2', 'K5L8P4T6'].join(''),
    STRIPE_SECRET_KEY: ['sk_', 'live_', 'Tq8Vz3Lm9Xc2Kd7Rp4Wn5Yb'].join(''),
    STRIPE_TEST_KEY: ['sk_', 'test_', 'Tq8Vz3Lm9Xc2Kd7Rp4Wn5Yb'].join(''),
    STRIPE_PUBLISHABLE_KEY: ['pk_', 'live_', 'Hn6Bv2Qx8Zc4Lm1Tr7Wd3Ys'].join(''),
    // A genuine token has a CRC32 checksum in its last six characters; the decoy below deliberately does not.
    GITHUB_TOKEN: ['ghp_', GITHUB_ENTROPY, githubTokenChecksum(GITHUB_ENTROPY)].join(''),
    FAKE_GITHUB_TOKEN: ['ghp_', 'abcdefghijklmnopqrstuvwxyz', '1234567890'].join(''),
    GITLAB_TOKEN: ['glpat-', 'Xq7Lm2Vz9Tc4Wd8Nb5Yp'].join(''),
    NPM_TOKEN: ['npm_', 'Kd8Vz3Lm9Xc2Rp4Wn5Yb7Qt1Hj6Fs0Aa3Bb9'].join(''),
    OPENAI_KEY: ['sk-', 'proj-', 'Tq8Vz3Lm9Xc2Kd7Rp4Wn5Yb1Hj6Fs0Aa3Bb9Cc2Dd'].join(''),
    ANTHROPIC_KEY: ['sk-ant-', 'api03-', 'Tq8Vz3Lm9Xc2Kd7Rp4Wn5Yb1Hj6Fs0'].join(''),
    SENDGRID_KEY: ['SG', '.', 'Tq8Vz3Lm9Xc2Kd7Rp4Wn5a', '.', 'Hj6Fs0Aa3Bb9Cc2Dd4Ee7Ff1Gg5Hh8Ii2Jj6Kk0Ll3M'].join(''),
    TWILIO_KEY: ['SK', '0123456789abcdef', 'fedcba9876543210'].join(''),
    AZURE_STORAGE_KEY: ['Account', 'Key=', 'Tq8Vz3Lm9Xc2Kd7Rp4Wn5Yb1Hj6Fs0Aa3Bb9Cc2Dd4Ee7Ff1Gg5Hh8Ii2Jj6Kk0Ll3Mm5Nn7Oo9Pp1Qq3Rr5Ss', '=='].join(''),
    GOOGLE_API_KEY: ['AIza', 'SyD3Tq8Vz3Lm9Xc2Kd7Rp4Wn5Yb1Hj6Fs0a'].join(''),
    DATABASE_URL: ['postgres://', 'app_user:', 'Zq8mTx4Lp2Vn9Kd', '@db.internal:5432/app'].join(''),
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
