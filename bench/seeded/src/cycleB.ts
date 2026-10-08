import { cycleA } from './cycleA';

export function cycleB(): string {
    return `b:${cycleA.name}`;
}
