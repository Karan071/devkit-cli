import { afterEach, describe, expect, it } from 'vitest';
import { createProgram } from '../ast/parse';
import { loadConfig } from '../config';
import { buildModuleGraph } from '../moduleGraph';
import { collectFunctionMetrics } from '../rules/complexity';
import { cleanupFixture, makeFixture } from './testUtils';

let dir: string | undefined;
afterEach(() => { if (dir) cleanupFixture(dir); dir = undefined; });

describe('complexity formula reference cases', () => {
    it('matches hand-counted McCabe and cognitive complexity values', () => {
        dir = makeFixture({
            'src/index.ts': `
function straight() { return 1; }
function single(value: boolean) { if (value) return 1; return 0; }
function chain(a: boolean, b: boolean) { if (a) return 1; else if (b) return 2; else return 0; }
function nested(value: boolean) { for (let i = 0; i < 1; i++) { if (value) break; } }
function switchThree(value: number) { switch (value) { case 1: return 1; case 2: return 2; case 3: return 3; } return 0; }
function logical(a: boolean, b: boolean, c: boolean) { return a && b && c; }
`
        });
        const config = loadConfig(dir);
        const files = [`${dir}/src/index.ts`];
        const context = {
            projectRoot: dir, files, allFiles: files, program: createProgram(files),
            moduleGraph: buildModuleGraph(dir, files, null, config), config, packageJson: null
        };
        const metrics = new Map(collectFunctionMetrics(context).map((metric) => [metric.name, metric]));
        expect([metrics.get('straight')?.cyclomatic, metrics.get('straight')?.cognitive]).toEqual([1, 0]);
        expect([metrics.get('single')?.cyclomatic, metrics.get('single')?.cognitive]).toEqual([2, 1]);
        expect([metrics.get('chain')?.cyclomatic, metrics.get('chain')?.cognitive]).toEqual([3, 2]);
        expect([metrics.get('nested')?.cyclomatic, metrics.get('nested')?.cognitive]).toEqual([3, 3]);
        expect([metrics.get('switchThree')?.cyclomatic, metrics.get('switchThree')?.cognitive]).toEqual([4, 1]);
        expect([metrics.get('logical')?.cyclomatic, metrics.get('logical')?.cognitive]).toEqual([3, 1]);
    });
});
