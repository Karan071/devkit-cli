# Benchmark

Answers one question: *is the scanner getting more accurate or less?* Tracked in [#8](https://github.com/Karan071/devkit-cli/issues/8).

| Part | What it is |
| --- | --- |
| `seeded/` | A small repo with planted issues (`// planted: <id>`) and known-clean decoys (`// decoy: <id>`). `seeded/expectations.json` names the rule that must catch each planted issue, and the rule that must stay quiet on each decoy. |
| `corpus.json` | Real repos pinned to full commit SHAs, so results do not drift. |
| `labels/*.jsonl` | Hand-labeled corpus findings: `{"repo","rule","file","line","verdict":true\|false,"reason"}`. |
| `baseline.json` | Per-rule accuracy the gate compares against. |

## Commands

```bash
npm run bench                       # report: catch rate + per-rule accuracy
npm run bench -- --json out.json    # also write structured JSON
npm run bench:check                 # CI gate (exit 1 on failure)
npm run bench -- --update-baseline  # record current accuracy as the baseline

npm run bench:corpus [repo...]      # clone corpus repos at their pinned commits and scan them
npm run bench:sample -- 30          # sample 30 findings per rule to label -> labels/<repo>.todo.jsonl
```

## How scores are computed

- **Catch rate** = planted issues reported by their rule at the planted line / planted issues.
- **Accuracy** (per rule) = real findings / labeled findings. A finding is *real* if it lands on a planted issue or is labeled `true`; it is *false* if it lands on a decoy (above its `tolerate` confidence) or is labeled `false`. `INFO` findings are visible but never cost points, so they are neither right nor wrong and are not scored. Findings with no label are not scored.
- A rule's figure is only trustworthy with 30+ labels; the report marks smaller counts `(low)`.

## The gate

`npm run bench:check` fails when:

1. a planted issue is not reported and is not tagged as a known gap, or
2. a rule's accuracy is more than 2 points below `baseline.json`.

A planted issue or decoy with an `"issue"` tag (e.g. `"G1"`, an item from #8) is a *known gap*: it is reported but does not fail the gate. When a fix lands, the report warns that the tag is stale; remove it, and refresh the baseline if accuracy improved.

## Adding a case

1. Add the code to `seeded/src/` with a `// planted: <id>` or `// decoy: <id>` comment on the line the finding is reported on (use `"line": "any"` for files that cannot hold comments, like `package.json`).
2. Add the entry to `seeded/expectations.json`.
3. Provider-shaped credentials must be written as `@@NAME@@` placeholders and defined in `lib/seeded.ts`, which assembles them from fragments when the repo is materialized. This keeps real-looking tokens out of the repository.

## Labeling corpus findings

1. `npm run bench:corpus` then `npm run bench:sample -- 30`.
2. Open `labels/<repo>.todo.jsonl`, read each finding in the pinned checkout under `.cache/<repo>`, set `verdict` and a one-line `reason`, and move the line into `labels/<repo>.jsonl`.
