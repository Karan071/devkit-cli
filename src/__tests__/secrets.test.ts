import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { computeScores } from '../scoring';
import { githubTokenChecksum, isValidGithubToken } from '../rules/secretPatterns';
import { buildFinding } from '../finding';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

let dir: string | undefined;

afterEach(() => {
    if (dir) cleanupFixture(dir);
    dir = undefined;
});

const secrets = (files: Record<string, string>) => {
    dir = makeFixture(files);
    return findingsFor(scanRepository(dir).findings, 'SEC001');
};

const validGithubToken = (() => {
    const entropy = 'Rk3Vx9Qm2Lz8Tc5Wd7Nb4Yp6Hj1Fs0';
    return `ghp_${entropy}${githubTokenChecksum(entropy)}`;
})();
// Fragments keep provider-shaped literals out of this file so push protection does not reject the test.
const join = (...parts: string[]) => parts.join('');

describe('SEC001 in TS/JS inspects string literals only (S1)', () => {
    it('never flags a comment that mentions a credential', () => {
        expect(secrets({ 'src/a.ts': `// token = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ2bD4f"\n/* password: 'Sup3rS3cr3t!Passw0rd2024' */\nexport const a = 1;\n` })).toHaveLength(0);
    });

    it('flags a literal assigned to a credential-like variable, property or field', () => {
        const found = secrets({
            'src/a.ts': [
                `export const apiKey = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ2bD4f';`,
                `export const options = { clientSecret: 'xY7zA9bC1dE3fG5hJ7kL9mN2pQ4rS6t' };`,
                `export class C { private authToken = 'tU8vW0xY2zA4bC6dE8fG0hJ2kL4mN6p'; }`
            ].join('\n')
        });
        expect(found.map((finding) => finding.line).sort()).toEqual([1, 2, 3]);
    });

    it('ignores non-literal values and names that merely contain a credential word', () => {
        expect(secrets({ 'src/a.ts': `declare const env: Record<string, string>;\nexport const token = env.TOKEN;\nexport const tokenizer = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ2bD4f';\nexport const passwordHash = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ2bD4f';\n` })).toHaveLength(0);
    });
});

describe('SEC001 judges values, never keys (S2, S3)', () => {
    it('does not flag package.json keys or dependency values', () => {
        expect(secrets({ 'package.json': JSON.stringify({ name: 'x', dependencies: { 'next-auth': 'github:nextauthjs/next-auth#v5.0.0-beta.25-with-long-ref' }, author: { name: 'Jane', url: 'https://jane.example/profile-page' }, contributors: ['Jane Doe <jane@example.com>'] }) })).toHaveLength(0);
    });

    it('does not flag YAML keys that contain "auth"', () => {
        expect(secrets({ 'config/app.yaml': `server:\n  authMiddleware: requireSessionHandlerName\n  auth: someLongHandlerIdentifier\n` })).toHaveLength(0);
    });

    it('flags a credential value in JSON, YAML and .env and reports its line', () => {
        const found = secrets({
            'config/a.json': `{\n  "name": "x",\n  "dbPassword": "Sup3rS3cr3t!Passw0rd2024"\n}\n`,
            'config/b.yaml': `db:\n  password: Sup3rS3cr3t!Passw0rd2024\n`,
            '.env.production': `# password=Sup3rS3cr3t!Passw0rd2024\nDB_PASSWORD=Sup3rS3cr3t!Passw0rd2024\n`
        });
        expect(found.map((finding) => `${finding.file}:${finding.line}`).sort()).toEqual(['.env.production:2', 'config/a.json:3', 'config/b.yaml:2']);
    });
});

describe('SEC001 value validation (S4) and hardcoded passwords (G2)', () => {
    it('still catches a strong password but not prose, identifiers or code', () => {
        const found = secrets({
            'src/a.ts': [
                `export const dbPassword = 'Sup3rS3cr3t!Passw0rd2024';`,
                `export const password = 'Enter your password here';`,
                `export const passwordLabel = 'passwordConfirmation';`,
                `export const pwd = 'getPasswordFromUserInput(request.body)';`,
                `export const token = 'user.profile.accessToken';`
            ].join('\n')
        });
        expect(found.map((finding) => finding.line)).toEqual([1]);
    });
});

describe('public-by-design and sample secrets are informational (S5, S6)', () => {
    it('reports Firebase web keys, Stripe publishable keys and anon JWTs as INFO', () => {
        const found = secrets({
            'src/firebase.ts': `export const config = { authDomain: 'x.firebaseapp.com', apiKey: '${join('AIza', 'SyD3Tq8Vz3Lm9Xc2Kd7Rp4Wn5Yb1Hj6Fs0a')}' };\n`,
            'src/billing.ts': `export const publishable = '${join('pk_', 'live_', 'Hn6Bv2Qx8Zc4Lm1Tr7Wd3Ys')}';\n`
        });
        expect(found).toHaveLength(2);
        expect(found.every((finding) => finding.severity === 'INFO' && finding.confidence === 'LOW')).toBe(true);
    });

    it('treats the same Google key outside a Firebase config as a real finding', () => {
        const [finding] = secrets({ 'src/maps.ts': `export const key = '${join('AIza', 'SyD3Tq8Vz3Lm9Xc2Kd7Rp4Wn5Yb1Hj6Fs0a')}';\n` });
        expect(finding.severity).toBe('HIGH');
    });

    it('demotes sample credentials in tests, fixtures and docs to INFO', () => {
        const found = secrets({
            'src/auth.test.ts': `export const sample = '${join('sk_', 'test_', 'Tq8Vz3Lm9Xc2Kd7Rp4Wn5Yb')}';\n`,
            'README.md': `Use the key ${join('AKIA', 'Z7Q3M9X2', 'K5L8P4T6')} in the docs.\n`
        });
        expect(found).toHaveLength(2);
        expect(found.every((finding) => finding.severity === 'INFO')).toBe(true);
    });

    it('keeps production-looking keys at full severity even in a test file', () => {
        const [finding] = secrets({ 'src/auth.test.ts': `export const key = '${join('AKIA', 'Z7Q3M9X2', 'K5L8P4T6')}';\n` });
        expect(finding.severity).toBe('HIGH');
        expect(finding.confidence).toBe('HIGH');
    });

    it('does not let informational findings lower the score', () => {
        const info = buildFinding({ ruleId: 'SEC001', category: 'security', severity: 'INFO', confidence: 'LOW', file: 'a.ts', line: 1, column: 1, message: '', description: '', evidence: '', suggestion: '' });
        expect(computeScores(Array.from({ length: 50 }, () => info), 500).securityScore).toBe(10);
    });
});

describe('more provider formats (G3)', () => {
    it.each([
        ['Google', join('AIza', 'SyD3Tq8Vz3Lm9Xc2Kd7Rp4Wn5Yb1Hj6Fs0a')],
        ['OpenAI', join('sk-', 'proj-', 'Tq8Vz3Lm9Xc2Kd7Rp4Wn5Yb1Hj6Fs0Aa3Bb9Cc2Dd')],
        ['Anthropic', join('sk-ant-', 'api03-', 'Tq8Vz3Lm9Xc2Kd7Rp4Wn5Yb1Hj6Fs0')],
        ['GitLab', join('glpat-', 'Xq7Lm2Vz9Tc4Wd8Nb5Yp')],
        ['npm', join('npm_', 'Kd8Vz3Lm9Xc2Rp4Wn5Yb7Qt1Hj6Fs0Aa3Bb9')],
        ['SendGrid', join('SG', '.', 'Tq8Vz3Lm9Xc2Kd7Rp4Wn5a', '.', 'Hj6Fs0Aa3Bb9Cc2Dd4Ee7Ff1Gg5Hh8Ii2Jj6Kk0Ll3M')],
        ['Twilio', join('SK', '0123456789abcdef', 'fedcba9876543210')],
        ['Azure', join('Account', 'Key=', 'Tq8Vz3Lm9Xc2Kd7Rp4Wn5Yb1Hj6Fs0Aa3Bb9Cc2Dd4Ee7Ff1Gg5Hh8Ii2Jj6Kk0Ll3Mm5Nn7Oo9Pp1Qq3Rr5Ss', '==')],
        ['database URL', join('postgres://', 'app_user:', 'Zq8mTx4Lp2Vn9Kd', '@db.internal:5432/app')],
        ['MongoDB URL', join('mongodb+srv://', 'admin:', 'Zq8mTx4Lp2Vn9Kd', '@cluster0.example.net/db')]
    ])('detects a %s credential', (_label, value) => {
        const found = secrets({ 'src/a.ts': `export const value = '${value}';\n` });
        expect(found).toHaveLength(1);
        expect(found[0].severity).toBe('HIGH');
    });

    it.each([
        'postgres://user:password@localhost:5432/app',
        'postgres://user:${DB_PASSWORD}@localhost/app',
        'postgres://user:<password>@localhost/app',
        'redis://localhost:6379',
        'sk-this-is-a-long-css-class-name-with-only-words-in-it'
    ])('does not flag %s', (value) => {
        expect(secrets({ 'src/a.ts': `export const value = '${value}';\n` })).toHaveLength(0);
    });
});

describe('GitHub token checksum (G4)', () => {
    it('validates the CRC32 checksum in the last six characters', () => {
        expect(isValidGithubToken(validGithubToken)).toBe(true);
        expect(isValidGithubToken(`${validGithubToken.slice(0, -1)}${validGithubToken.endsWith('a') ? 'b' : 'a'}`)).toBe(false);
        expect(isValidGithubToken('ghp_tooshort')).toBe(false);
    });

    it('reports a valid token at HIGH confidence and a fake one at LOW', () => {
        const [real] = secrets({ 'src/a.ts': `export const value = '${validGithubToken}';\n` });
        expect(real.confidence).toBe('HIGH');
        const [fake] = secrets({ 'src/b.ts': `export const value = '${join('ghp_', 'abcdefghijklmnopqrstuvwxyz', '1234567890')}';\n` });
        expect(fake.confidence).toBe('LOW');
    });
});

describe('SEC007 TLS verification patterns (G1)', () => {
    const tls = (source: string) => {
        dir = makeFixture({ 'src/a.ts': source });
        return findingsFor(scanRepository(dir).findings, 'SEC007');
    };

    it.each([
        `new https.Agent({ rejectUnauthorized: false });`,
        `request({ url, strictSSL: false });`,
        `connect({ insecure: true });`,
        `tls.connect({ checkServerIdentity: () => undefined });`,
        `tls.connect({ checkServerIdentity() {} });`.replace('checkServerIdentity() {}', 'checkServerIdentity: function () {}'),
        `agent.options.rejectUnauthorized = false;`
    ])('flags %s', (source) => {
        expect(tls(`declare const https: any, request: any, connect: any, tls: any, agent: any, url: string;\n${source}\n`)).toHaveLength(1);
    });

    it.each([
        `new https.Agent({ rejectUnauthorized: true });`,
        `request({ strictSSL: true });`,
        `tls.connect({ checkServerIdentity: (host: string, cert: unknown) => verify(host, cert) });`
    ])('does not flag %s', (source) => {
        expect(tls(`declare const https: any, request: any, tls: any, verify: any;\n${source}\n`)).toHaveLength(0);
    });
});

describe('SEC008 SQL call patterns (G5) and query variables (G6)', () => {
    const sql = (source: string) => {
        dir = makeFixture({ 'src/a.ts': `declare const db: any, pool: any, client: any, knex: any, sequelize: any, prisma: any, id: string;\n${source}\n` });
        return findingsFor(scanRepository(dir).findings, 'SEC008');
    };

    it.each([
        'knex.raw(`SELECT * FROM users WHERE id = ${id}`);',
        'sequelize.query(`SELECT * FROM users WHERE id = ${id}`);',
        'pool.query("SELECT * FROM users WHERE id = " + id);',
        'client.query(`DELETE FROM users WHERE id = ${id}`);',
        'prisma.$queryRawUnsafe(`SELECT * FROM users WHERE id = ${id}`);',
        'prisma.$executeRawUnsafe(`UPDATE users SET a = 1 WHERE id = ${id}`);'
    ])('flags %s', (source) => {
        expect(sql(source)).toHaveLength(1);
    });

    it('flags a query built in a variable and passed in later', () => {
        expect(sql('export function f() {\n  const q = `SELECT * FROM users WHERE id = ${id}`;\n  return db.query(q);\n}')).toHaveLength(1);
    });

    it.each([
        'db.query("SELECT * FROM users WHERE id = $1", [id]);',
        'export function f() {\n  const q = "SELECT * FROM users";\n  return db.query(q);\n}',
        'prisma.$queryRaw`SELECT * FROM users WHERE id = ${id}`;',
        'db.raw(`not a query ${id}`);'
    ])('does not flag %s', (source) => {
        expect(sql(source)).toHaveLength(0);
    });
});

describe('translated text and public search keys', () => {
    it('does not treat a sentence key, non-ASCII prose or a hyphenated label as a credential', () => {
        const found = secrets({
            'i18n/ja.json': JSON.stringify({ 'Amy decided to strengthen her password.': 'チャレンジの説明には、パスワード強化方法に関する手がかりがあります。' }),
            'i18n/es.json': JSON.stringify({ LABEL_PASSWORD: 'Contraseña', LABEL_TWO_FACTOR_TOKEN: 'Zwoifaktor-Authentisierungs-Token' }),
            'i18n/real.json': JSON.stringify({ dbPassword: 'Sup3rS3cr3t!Passw0rd2024' })
        });
        expect(found.map((finding) => finding.file)).toEqual(['i18n/real.json']);
    });

    it('does not report the search-only key of an Algolia DocSearch config, but still reports another apiKey', () => {
        const found = secrets({
            'docusaurus.config.js': `module.exports = { algolia: { appId: 'ABC', apiKey: 'ed8b3896f8e3e2b421e4c38834b915a8', indexName: 'docs' } };\n`,
            'src/client.ts': `export const options = { apiKey: 'ed8b3896f8e3e2b421e4c38834b915a8' };\n`
        });
        expect(found.map((finding) => finding.file)).toEqual(['src/client.ts']);
    });
});
