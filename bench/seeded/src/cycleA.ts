import { cycleB } from './cycleB'; // planted: import-cycle

export function cycleA(): string {
    return `a:${cycleB.name}`;
}
