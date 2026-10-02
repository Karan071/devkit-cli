import path from 'node:path';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { buildModuleGraph } from '../moduleGraph';
import { cleanupFixture, makeFixture } from './testUtils';

let dir: string | undefined;
afterEach(() => { if (dir) cleanupFixture(dir); dir = undefined; });

describe('module graph', () => {
    it('builds edges, reverse edges and package entry points including exports and Next conventions', () => {
        dir = makeFixture({
            'package.json': JSON.stringify({ name: 'fixture', main: 'src/main.ts', exports: { '.': { import: './src/public.ts' } }, dependencies: { next: '^15.0.0' } }),
            'src/main.ts': "import { helper } from './helper'; const { helper: viaRequire } = require('./helper'); require('./public'); export const main = helper() + viaRequire();",
            'src/helper.ts': 'export function helper() { return 1; }',
            'src/public.ts': 'export const publicApi = 1;',
            'app/page.tsx': 'export default function Page() { return null; }'
        });
        const files = ['src/main.ts', 'src/helper.ts', 'src/public.ts', 'app/page.tsx'].map((file) => path.join(dir!, file));
        const graph = buildModuleGraph(dir, files, JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')), loadConfig(dir));
        expect(graph.edges.get(files[0])).toContain(files[1]);
        expect(graph.reverseEdges.get(files[1])).toContain(files[0]);
        expect(graph.entryPoints).toContain(files[0]);
        expect(graph.entryPoints).toContain(files[2]);
        expect(graph.entryPoints).toContain(files[3]);
        const requireImports = graph.importsByFile.get(files[0])!.filter((item) => item.kind === 'require');
        expect(requireImports[0].namedImports).toEqual(['helper']);
        expect(requireImports[0].hasNamespaceImport).toBe(false);
        expect(requireImports[1].hasNamespaceImport).toBe(true);
    });
});
