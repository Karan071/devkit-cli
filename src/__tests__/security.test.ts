import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

let dir: string | undefined;

afterEach(() => {
    if (dir) cleanupFixture(dir);
    dir = undefined;
});

describe('security rules', () => {
    it('flags a hardcoded secret', () => {
        dir = makeFixture({ 'src/index.ts': `export const API_KEY = "sk_live_abcdefg12345";\n` });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'SEC001').length).toBeGreaterThan(0);
    });

    it.each([
        ['AWS', `const credential = "AKIAIOSFODNN7EXAMPLE";`],
        ['GitHub', `const credential = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";`],
        ['PEM', `const value = "-----BEGIN PRIVATE KEY-----";`],
        ['JWT', `const value = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepayload";`]
    ])('detects a %s-shaped credential regardless of variable name', (_label, source) => {
        dir = makeFixture({ 'src/index.ts': source });
        expect(findingsFor(scanRepository(dir).findings, 'SEC001').length).toBeGreaterThan(0);
    });

    it('suppresses only heuristic secret matches in test fixtures', () => {
        dir = makeFixture({ 'src/example.test.ts': `const TOKEN = "this-is-a-long-but-not-provider-specific-test-string";` });
        expect(findingsFor(scanRepository(dir).findings, 'SEC001')).toHaveLength(0);
    });

    it('flags eval usage', () => {
        dir = makeFixture({ 'src/index.ts': `export function run(code: string) {\n    return eval(code);\n}\n` });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'SEC002').length).toBeGreaterThan(0);
    });

    it('flags exec with a dynamically built command', () => {
        dir = makeFixture({
            'src/index.ts': `import { exec } from 'node:child_process';\nexport function run(userPath: string) {\n    exec('rm -rf ' + userPath);\n}\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'SEC003').length).toBeGreaterThan(0);
    });

    it('does not flag exec with a literal command', () => {
        dir = makeFixture({
            'src/index.ts': `import { exec } from 'node:child_process';\nexport function run() {\n    exec('ls -la');\n}\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'SEC003').length).toBe(0);
    });

    it('flags a one-hop dynamically built command passed through a variable', () => {
        dir = makeFixture({ 'src/index.ts': `import { exec } from 'node:child_process';\nexport function run(input: string) { const command = 'echo ' + input; exec(command); }` });
        expect(findingsFor(scanRepository(dir).findings, 'SEC003').length).toBeGreaterThan(0);
    });

    it('flags shell:true for spawn-family calls', () => {
        dir = makeFixture({ 'src/index.ts': `import { spawn } from 'node:child_process';\nspawn('sh', ['-c', input], { shell: true });` });
        expect(findingsFor(scanRepository(dir).findings, 'SEC003').length).toBeGreaterThan(0);
    });

    it('flags unsafe innerHTML assignment', () => {
        dir = makeFixture({
            'src/index.ts': `export function run(el: { innerHTML: string }, content: string) {\n    el.innerHTML = content;\n}\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'SEC004').length).toBeGreaterThan(0);
    });

    it('flags insertAdjacentHTML calls', () => {
        dir = makeFixture({ 'src/index.ts': `export function render(el: Element, html: string) { el.insertAdjacentHTML('beforeend', html); }` });
        expect(findingsFor(scanRepository(dir).findings, 'SEC004').length).toBeGreaterThan(0);
    });

    it.each(['src/template.vue', 'src/template.html'])('flags unsafe HTML bindings in %s', (file) => {
        dir = makeFixture({ [file]: `<div v-html="value"></div>\n<div [innerHTML]="other"></div>` });
        expect(findingsFor(scanRepository(dir).findings, 'SEC004').length).toBeGreaterThan(0);
    });

    it('flags dynamically constructed SQL queries', () => {
        dir = makeFixture({ 'src/index.ts': 'db.query(`SELECT * FROM users WHERE id = ${id}`);' });
        expect(findingsFor(scanRepository(dir).findings, 'SEC008').length).toBeGreaterThan(0);
    });

    it('flags request data passed into filesystem paths', () => {
        dir = makeFixture({ 'src/index.ts': "fs.readFileSync(path.join(root, req.params.file));" });
        expect(findingsFor(scanRepository(dir).findings, 'SEC009').length).toBeGreaterThan(0);
    });

    it('flags unsafe deserialization and VM execution calls', () => {
        dir = makeFixture({ 'src/index.ts': "import { unserialize } from 'node-serialize';\nunserialize(input);\nvm.runInNewContext(input);" });
        expect(findingsFor(scanRepository(dir).findings, 'SEC010').length).toBeGreaterThan(0);
    });

    it('flags weak hash algorithms', () => {
        dir = makeFixture({
            'src/index.ts': `import { createHash } from 'node:crypto';\nexport function run(data: string) {\n    return createHash('md5').update(data).digest('hex');\n}\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'SEC005').length).toBeGreaterThan(0);
    });

    it('does not flag strong hash algorithms', () => {
        dir = makeFixture({
            'src/index.ts': `import { createHash } from 'node:crypto';\nexport function run(data: string) {\n    return createHash('sha256').update(data).digest('hex');\n}\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'SEC005').length).toBe(0);
    });
});

describe('secret scan beyond JS/TS files', () => {
    let fixture: string | undefined;
    afterEach(() => { if (fixture) cleanupFixture(fixture); fixture = undefined; });

    it('finds credentials in YAML, JSON and .env files', () => {
        fixture = makeFixture({
            'src/index.ts': 'export const a = 1;',
            'config/settings.yaml': 'stripe_key: sk_live_abcdefghijklmnop1234',
            'config/creds.json': '{"token":"ghp_abcdefghijklmnopqrstuvwxyz1234567890"}',
            'deploy/.env.production': 'DATABASE_PASSWORD=Zk8#qP2!vR9xLm4Tq7Wn'
        });
        const files = scanRepository(fixture).findings.filter((finding) => finding.ruleId === 'SEC001').map((finding) => finding.file).sort();
        expect(files).toEqual(['config/creds.json', 'config/settings.yaml', 'deploy/.env.production']);
    });

    it('ignores placeholder values in config files', () => {
        fixture = makeFixture({ 'src/index.ts': 'export const a = 1;', '.env.example': 'API_KEY=your-api-key-goes-here-please' });
        expect(scanRepository(fixture).findings.filter((finding) => finding.ruleId === 'SEC001')).toHaveLength(0);
    });
});
