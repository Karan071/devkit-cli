import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { cleanupFixture, makeFixture } from './testUtils';
import type { Finding } from '../types';

let dir: string | undefined;

afterEach(() => {
    if (dir) cleanupFixture(dir);
    dir = undefined;
});

/** Scans a handler file and returns the security findings, with the program given just enough ambient types. */
function scan(source: string, extra: Record<string, string> = {}): Finding[] {
    dir = makeFixture({
        'package.json': JSON.stringify({ name: 'x', main: 'src/index.ts' }),
        'src/env.d.ts': 'declare const app: any, db: any, mysql: any, schema: any, ALLOWED: string[], z: any, items: any[];\ndeclare const _: any;\n',
        'src/index.ts': `import { exec } from 'node:child_process';\nimport fs from 'node:fs';\nimport path from 'node:path';\n${source}\nexport {};\n`,
        ...extra
    });
    return scanRepository(dir).findings.filter((finding) => finding.category === 'security');
}
const handler = (body: string) => `app.get('/x', async (req: any, res: any) => {\n${body}\n});`;
const taintFlows = (findings: Finding[], ruleId: string) => findings.filter((finding) => finding.ruleId === ruleId && finding.description.includes('flows to'));

describe('taint: request inputs reach dangerous calls (T1)', () => {
    it('follows a variable into command execution and names the source', () => {
        const [finding] = taintFlows(scan(handler('    const cmd = req.query.cmd;\n    exec(`ls ${cmd}`);')), 'SEC003');
        expect(finding.confidence).toBe('HIGH');
        expect(finding.description).toContain('req.query');
        expect(finding.evidence).toContain('cmd');
    });

    it('follows destructuring into a filesystem call', () => {
        expect(taintFlows(scan(handler('    const { name } = req.body;\n    fs.readFileSync(name);')), 'SEC009')).toHaveLength(1);
    });

    it('follows path.join into a filesystem call', () => {
        expect(taintFlows(scan(handler("    const file = path.join('/data', req.params.file);\n    fs.readFile(file, () => undefined);")), 'SEC009')).toHaveLength(1);
    });

    it('follows data into SQL built with string concatenation, as one finding that is now high confidence', () => {
        const findings = scan(handler("    await db.query('SELECT * FROM users WHERE name = ' + req.query.name);")).filter((finding) => finding.ruleId === 'SEC008');
        expect(findings).toHaveLength(1);
        expect(findings[0].confidence).toBe('HIGH');
        expect(findings[0].description).toContain('flows to');
    });

    it('finds eval, new Function and vm sinks', () => {
        const findings = scan(handler("    eval(req.body.code);\n    new Function(req.body.fn);"));
        expect(taintFlows(findings, 'SEC002')).toHaveLength(2);
    });

    it('follows data into a helper function in the same file and reports the call site', () => {
        const findings = scan(`function run(command: string) {\n    exec(command);\n}\n${handler('    run(req.query.cmd);')}`);
        const [finding] = taintFlows(findings, 'SEC003');
        expect(finding.description).toContain('passed to run()');
        expect(finding.confidence).toBe('MEDIUM');
    });

    it('follows data through a helper in another file', () => {
        const findings = scan(`import { runShell } from './shell';\n${handler('    runShell(req.query.cmd);')}`, {
            'src/shell.ts': `import { exec } from 'node:child_process';\nexport function runShell(command: string) {\n    exec('sh -c ' + command);\n}\n`
        });
        expect(taintFlows(findings, 'SEC003')).toHaveLength(1);
    });

    it('follows a value returned from a helper', () => {
        const findings = scan(`function pick(request: any) {\n    return request.query.id;\n}\n${handler("    fs.readFileSync(pick(req));")}`);
        expect(taintFlows(findings, 'SEC009')).toHaveLength(1);
    });

    it('follows data into a closure', () => {
        expect(taintFlows(scan(handler('    const id = req.query.id;\n    items.forEach(() => exec("rm " + id));')), 'SEC003')).toHaveLength(1);
    });

    it('knows Hono, Koa and Next inputs', () => {
        const findings = scan([
            `app.get('/h', async (c: any) => {\n    const target = c.req.query('url');\n    await fetch(target);\n});`,
            `app.get('/k', async (ctx: any) => {\n    exec('ls ' + ctx.query.dir);\n});`,
            `export async function POST(request: any) {\n    const body = await request.json();\n    exec('echo ' + body.text);\n}`
        ].join('\n'));
        expect(taintFlows(findings, 'SEC013')).toHaveLength(1);
        expect(taintFlows(findings, 'SEC003')).toHaveLength(2);
    });

    it('treats Nest parameter decorators as request inputs', () => {
        const findings = scan(`declare function Get(): MethodDecorator;\ndeclare function Query(name?: string): ParameterDecorator;\nexport class Controller {\n    @Get()\n    find(@Query('q') q: string) {\n        return fetch(q);\n    }\n}`);
        expect(taintFlows(findings, 'SEC013')).toHaveLength(1);
    });

    it('reports process.argv flows at MEDIUM confidence', () => {
        const [finding] = taintFlows(scan("exec('convert ' + process.argv[2]);"), 'SEC003');
        expect(finding.confidence).toBe('MEDIUM');
    });

    it('does not report data that never came from a request', () => {
        const findings = scan("export function f(name: string) {\n    return exec('ls ' + name);\n}");
        expect(taintFlows(findings, 'SEC003')).toHaveLength(0);
    });

    it('does not mistake regex.exec or a database exec for child_process', () => {
        const findings = scan(handler('    /a(.)/.exec(req.query.x);\n    db.exec(req.query.sql);'));
        expect(taintFlows(findings, 'SEC003')).toHaveLength(0);
    });

    it('does not treat Hono validated input as a source', () => {
        const findings = scan(`app.post('/v', async (c: any) => {\n    const data = c.req.valid('json');\n    exec('echo ' + data.text);\n});`);
        expect(taintFlows(findings, 'SEC003')).toHaveLength(0);
    });
});

describe('taint: known cleaning steps stop a flow (T2)', () => {
    it.each([
        ['parseInt', '    const id = parseInt(req.query.id, 10);\n    exec("kill " + id);'],
        ['Number', '    exec("sleep " + Number(req.query.n));'],
        ['schema validation', '    const input = schema.parse(req.body);\n    exec("echo " + input.text);'],
        ['zod', '    const input = z.object({}).parse(req.body);\n    exec("echo " + input.text);'],
        ['an allowlist guard that exits', '    const cmd = req.query.cmd;\n    if (!ALLOWED.includes(cmd)) return;\n    exec(cmd);'],
        ['an allowlist guard around the use', '    const cmd = req.query.cmd;\n    if (ALLOWED.includes(cmd)) {\n        exec(cmd);\n    }'],
        ['a format check that throws', '    const name = req.query.name;\n    if (!/^[\\w-]+$/.test(name)) throw new Error("bad");\n    exec("echo " + name);'],
        ['a literal comparison', '    const mode = req.query.mode;\n    if (mode === "fast") exec("run --" + mode);'],
        ['a typeof number check', '    const n = req.query.n;\n    if (typeof n === "number") exec("sleep " + n);'],
        ['reassigning a safe value', '    let value = req.query.v;\n    value = "fixed";\n    exec("echo " + value);']
    ])('is stopped by %s', (_label, body) => {
        expect(taintFlows(scan(handler(body)), 'SEC003')).toHaveLength(0);
    });

    it('lets path.basename clean a path but not a shell command', () => {
        const findings = scan(handler('    const file = path.basename(req.query.file);\n    fs.readFileSync(file);\n    exec("cat " + file);'));
        expect(taintFlows(findings, 'SEC009')).toHaveLength(0);
        expect(taintFlows(findings, 'SEC003')).toHaveLength(1);
    });

    it('lets SQL escaping clean a query but not a path', () => {
        const findings = scan(handler("    const name = mysql.escape(req.query.name);\n    await db.query('SELECT * FROM t WHERE n = ' + name);\n    fs.readFileSync(name);"));
        expect(taintFlows(findings, 'SEC008')).toHaveLength(0);
        expect(taintFlows(findings, 'SEC009')).toHaveLength(1);
    });

    it('does not report a parameterized query', () => {
        const findings = scan(handler("    await db.query('SELECT * FROM t WHERE id = $1', [req.query.id]);"));
        expect(findings.filter((finding) => finding.ruleId === 'SEC008')).toHaveLength(0);
    });

    it('keeps the flow when only part of the data was cleaned', () => {
        const findings = scan(handler('    const a = parseInt(req.query.a);\n    const b = req.query.b;\n    exec("x " + a + b);'));
        expect(taintFlows(findings, 'SEC003')).toHaveLength(1);
    });
});

describe('taint: containment checks and confidence', () => {
    it.each([
        ['resolve then startsWith(root)', "    const p = path.resolve('root', req.query.f);\n    if (!p.startsWith(path.resolve('root'))) return;\n    fs.readFileSync(p);"],
        ['path.relative(root, p).startsWith("..")', "    const p = path.resolve('root', req.query.f);\n    if (path.relative('root', p).startsWith('..')) throw new Error('no');\n    fs.readFileSync(p);"],
        ['rejecting names that contain a slash', "    const file = req.params.file;\n    if (file.includes('/')) return;\n    fs.readFileSync('keys/' + file);"],
        ['an allowlisted ternary on the same expression', "    const url = req.body.url;\n    const ext = ['jpg', 'png'].includes(url.split('.').pop()) ? url.split('.').pop() : 'jpg';\n    fs.writeFileSync(`uploads/${ext}`, 'x');"]
    ])('stops a path flow after %s', (_label, body) => {
        expect(taintFlows(scan(handler(body)), 'SEC009')).toHaveLength(0);
    });

    it('does not let a startsWith check clear a command', () => {
        const findings = scan(handler("    const p = path.resolve('root', req.query.f);\n    if (!p.startsWith(path.resolve('root'))) return;\n    exec('cat ' + p);"));
        expect(taintFlows(findings, 'SEC003')).toHaveLength(1);
    });

    it('is less sure when fixed text follows the tainted part of a path', () => {
        const findings = scan(handler("    fs.readFileSync('./data/' + req.body.key + '.yml');\n    fs.readFileSync('./data/' + req.body.name);"));
        const flows = taintFlows(findings, 'SEC009').sort((a, b) => a.line - b.line);
        expect(flows.map((finding) => finding.confidence)).toEqual(['MEDIUM', 'HIGH']);
    });
});

describe('taint: child_process through namespaces and require', () => {
    it('finds exec called on a namespace import and on a required module', () => {
        const findings = scan(`import * as cp from 'node:child_process';\nconst legacy = require('child_process');\n${handler('    cp.exec("ls " + req.query.a);\n    legacy.execSync("ls " + req.query.b);')}`);
        expect(taintFlows(findings, 'SEC003')).toHaveLength(2);
    });
});

describe('taint: retracting pattern-based false alarms', () => {
    it('drops the heuristic finding when the dynamic value was explicitly cleaned', () => {
        const findings = scan(handler('    exec(`sleep ${parseInt(req.query.s, 10)}`);\n    fs.readFileSync(path.join(req.params.dir, path.basename(req.params.name)));'));
        expect(findings.filter((finding) => finding.ruleId === 'SEC003')).toHaveLength(0);
    });

    it('keeps the heuristic finding when only part of the value was cleaned', () => {
        const findings = scan(handler('    exec(`sleep ${parseInt(req.query.s, 10)} ${req.query.extra}`);'));
        expect(findings.filter((finding) => finding.ruleId === 'SEC003')).toHaveLength(1);
    });
});

describe('taint: new security rules (T3)', () => {
    it('reports an open redirect, but not one pinned to a path or guarded', () => {
        const findings = scan(handler([
            '    res.redirect(req.query.next);',
            "    res.redirect('/login?next=' + req.query.next);",
            '    const target = req.query.to;',
            "    if (target.startsWith('/') && !target.startsWith('//')) res.redirect(target);",
            '    res.redirect(encodeURIComponent(req.query.q));'
        ].join('\n')));
        const redirects = taintFlows(findings, 'SEC012');
        expect(redirects).toHaveLength(1);
        expect(redirects[0].line).toBeLessThan(10);
    });

    it('reports SSRF only when the tainted part chooses the host', () => {
        const findings = scan(handler([
            '    await fetch(req.query.url);',
            '    await fetch(`${req.query.base}/items`);',
            '    await fetch(`https://api.example.com/items/${req.query.id}`);',
            "    await fetch('https://api.example.com/items/' + req.query.id);"
        ].join('\n')));
        expect(taintFlows(findings, 'SEC013')).toHaveLength(2);
    });

    it('lets a URL origin check clear SSRF', () => {
        const findings = scan(handler("    const url = req.query.url;\n    if (new URL(url).origin !== 'https://api.example.com') return;\n    await fetch(url);"));
        expect(taintFlows(findings, 'SEC013')).toHaveLength(0);
    });

    it('reports a regular expression built from request data unless escaped', () => {
        const findings = scan(handler([
            '    new RegExp(req.query.q);',
            "    new RegExp(req.query.q.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'));"
        ].join('\n')));
        expect(taintFlows(findings, 'SEC014')).toHaveLength(1);
    });

    it('reports a nested write keyed by request data', () => {
        const findings = scan(handler('    const store: any = {};\n    store[req.body.group][req.body.key] = req.body.value;'));
        expect(taintFlows(findings, 'SEC011')).toHaveLength(1);
    });

    it('stays quiet about that write when the file guards against __proto__', () => {
        const findings = scan(handler('    const store: any = {};\n    if (req.body.group === "__proto__") return;\n    store[req.body.group][req.body.key] = req.body.value;'));
        expect(taintFlows(findings, 'SEC011')).toHaveLength(0);
    });

    it('reports request data merged with a merge library, not with a local function named merge', () => {
        const library = scan(`import { merge } from 'lodash';\n${handler('    merge({}, req.body);')}`);
        expect(taintFlows(library, 'SEC011')).toHaveLength(1);
        const local = scan(`function merge(a: any, b: any) { return { ...a, ...b }; }\n${handler('    merge({}, req.body);')}`);
        expect(taintFlows(local, 'SEC011')).toHaveLength(0);
    });
});
