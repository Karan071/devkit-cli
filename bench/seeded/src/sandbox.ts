import vm from 'node:vm';

export function runUntrusted(code: string): unknown {
    return vm.runInNewContext(code, {}); // planted: dynamic-execution
}
