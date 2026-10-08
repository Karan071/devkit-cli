import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runShell } from './runner';

declare const app: { get(route: string, handler: (req: any, res: any) => unknown): void };
declare const ALLOWED: string[];
declare function escapeRegExp(value: string): string;

export function registerRoutes(): void {
    app.get('/run', (req, res) => {
        exec(`convert ${req.query.file}`); // planted: taint-command
        res.send('ok');
    });

    app.get('/proxy', async (req, res) => {
        const response = await fetch(req.query.url); // planted: taint-ssrf
        res.send(await response.text());
    });

    app.get('/go', (req, res) => {
        res.redirect(req.query.next); // planted: taint-redirect
    });

    app.get('/search', (req, res) => {
        const pattern = new RegExp(req.query.q); // planted: taint-regexp
        res.send(String(pattern));
    });

    app.get('/settings', (req, res) => {
        const settings: any = {};
        settings[req.body.group][req.body.key] = req.body.value; // planted: taint-pollution
        res.send(settings);
    });

    app.get('/file', (req, res) => {
        const target = path.join('/srv/files', req.params.name);
        res.send(fs.readFileSync(target)); // planted: taint-path
    });

    app.get('/helper', (req, res) => {
        runShell(req.query.cmd); // planted: taint-via-helper
        res.send('ok');
    });

    app.get('/safe-number', (req, res) => {
        exec(`sleep ${parseInt(req.query.seconds, 10)}`); // decoy: taint-parsed-number
        res.send('ok');
    });

    app.get('/safe-allowlist', (req, res) => {
        const tool = req.query.tool;
        if (!ALLOWED.includes(tool)) return res.status(400).end();
        exec(tool); // decoy: taint-allowlist
        return res.send('ok');
    });

    app.get('/safe-basename', (req, res) => {
        res.send(fs.readFileSync(path.basename(req.params.name))); // decoy: taint-basename
    });

    app.get('/safe-redirect', (req, res) => {
        res.redirect(`/login?next=${req.query.next}`); // decoy: taint-pinned-redirect
    });

    app.get('/safe-proxy', async (req, res) => {
        const response = await fetch(`https://api.example.com/items/${req.query.id}`); // decoy: taint-fixed-host
        res.send(await response.text());
    });

    app.get('/safe-search', (req, res) => {
        const pattern = new RegExp(escapeRegExp(req.query.q)); // decoy: taint-escaped-regexp
        res.send(String(pattern));
    });
}
