import fs from 'node:fs';

interface Request {
    query: { expr: string };
    params: { name: string };
}

export function evaluate(req: Request): unknown {
    return eval(req.query.expr); // planted: eval
}

export function readUpload(req: Request): string {
    return fs.readFileSync('/uploads/' + req.params.name, 'utf8'); // planted: path-traversal
}
