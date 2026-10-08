export function renderGreeting(target: HTMLElement, name: string): void {
    target.innerHTML = `<h1>Hello ${name}</h1>`; // planted: innerHTML
}

export function renderStatic(target: HTMLElement): void {
    target.innerHTML = '<h1>Hello</h1>'; // decoy: literal-html - static markup
}
