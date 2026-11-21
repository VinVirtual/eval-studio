---
name: eval-studio
description: Test a chatbot, a retrieval (RAG) system or an AI agent the way software is tested. Test cases are run against the real system (an HTTP endpoint, a shell command, a JavaScript function or an OpenAI-compatible chat endpoint), the answers are scored with plain checks (contains, regex, JSON shape, numbers, "retrieved source X", "called tool Y with these arguments", refusals, latency, length) and an optional, clearly marked model-judged check, each run is compared with the last one, and a single-file HTML report shows what passed, what failed and what got worse. Exits non-zero on regressions, for CI. Use whenever the user wants to test, evaluate, benchmark or regression-test a chatbot, assistant, RAG pipeline, retrieval, prompt change, model switch or agent; asks "did my change make the bot worse", "write test cases for my bot", "evals", "eval suite", "golden set", "LLM tests", "check my RAG answers", "compare two prompts or models"; or wants such tests in CI.
---

# eval-studio

Cases → **run** against the target → **score** with checks → **compare** with the last run → **report** page. Plain Node 18+, no packages to install, nothing sent anywhere except to the target (and to a judge model only if the user turns that on).

Skill folder: `~/.claude/skills/eval-studio/` (written below as `$E`). Every command is `$E/evals <command> [project]`. `$E/evals help` lists them.

```
$E/evals                     the command line (check, new, import, lint, run, score, compare, report, baseline, build, test)
$E/engine/lib/checks/        the check types           $E/references/checks.md    every check and its fields
$E/engine/lib/adapters/      the target types          $E/references/targets.md   every target and its settings
$E/engine/report/            the report page (HTML, CSS, JS, inlined into one file)
$E/templates/                what `evals new` copies   $E/examples/tool-library/  a complete small example
$E/examples/ci/evals.yml     a GitHub Actions workflow that fails a pull request on regressions
```

## Workflow

1. **Check**: `$E/evals check [dir]`. Node version, and in a project the config, the target type and whether the environment variables it names are set.
2. **Scaffold**: `$E/evals new <dir>`. Put the folder in the user's repo (for example `evals/`) so cases, the baseline and the workflow are versioned with the code they test.
3. **Point it at the system**: set `target` in `evals.config.json` (see `references/targets.md`). Prefer testing the real entry point users hit (`http` or `module`) over the bare model (`openai`), or retrieval is not tested. Keys only as `${NAME}` or `apiKeyEnv`; never write a key into a file.
4. **Write cases with the user** (rules below). JSONL, one case per line. A spreadsheet of questions can come in as CSV: `$E/evals import cases.csv`.
5. **Lint**: `$E/evals lint <dir>`. Fix every error: duplicate ids, cases with no check, unknown check types, bad patterns or shapes, missing environment variables, a target that does not answer. `--offline` skips the reachability probe.
6. **First run**: `$E/evals build <dir> --label first`. Look at the failures with the user before anything else: each one is either a bug in the system or a bad case. Fix bad cases (wrong expected fact, check too strict) and run again.
7. **Freeze a baseline** once the results are understood: `$E/evals baseline <dir>` copies the newest scored run to the `baseline` file named in the config. Commit it.
8. **After every change** to prompts, model, retrieval, chunking or tools: `$E/evals build <dir> --label <what-changed>`. It lints, runs, scores, compares with the baseline (or the previous run) and writes `report.html`. Exit code 1 means the gate failed.
9. **Look at the report** before telling the user anything: open `report.html` in a browser, or with Playwright take a screenshot and Read it. Report: the score and its change, every case that **got worse** with the reason, what was fixed, flaky cases, and the latency change. Do not summarise a regression as "minor" without reading the answer.
10. **CI**: copy `examples/ci/evals.yml` and adjust paths. Gate settings are in the config (`gate`) or flags (`--max-regressions`, `--max-score-drop`, `--max-latency-increase`).

## Writing good cases with the user

Ask for material before writing anything: real questions from logs, support tickets, the FAQ, and the documents the bot answers from. Then:

- **Real questions, in users' words.** Typos, vague phrasing and follow-ups are fine; they are what the bot gets. Do not polish them into exam questions.
- **Expected facts come from the user's own documents, never from your own knowledge.** Quote or point to the passage (`"expected": "30 days (returns.md)"`). If the documents do not say, ask the user or leave the case out. Never invent a price, date, policy or number. A case built on a made-up fact makes a correct bot fail.
- **Check the fact, not the wording.** `contains` on the key phrase or number, `number` with a tolerance, `source` for the document that holds the answer. Avoid `exact` except for fixed strings (a help line, a JSON field).
- **Cover the edges**: questions the documents answer only across two passages, near-miss wording, numbers that need a sum, out-of-date terms, a question in another language if users write in one, very long input, an empty or one-word message.
- **Things the bot must refuse or must not do**: out-of-scope questions (`refusal`), requests for personal data or for advice it must not give (`refusal` plus `not-contains`), a tool it must not call (`no-tool-call`). Ask the user what the bot must never say or do; these are often the most important cases.
- **Agents**: one case per tool decision. "Must call X with arguments like Y" for the happy path, "must not call Z" for look-alike requests (a question about reserving must not make a reservation).
- **A small must-never-regress set**: tag 5 to 20 cases `must-pass`. They fail the gate even with no baseline. Pick what would embarrass or harm: wrong prices, safety, privacy, refusals.
- **One idea per case, an id that says what it is** (`late-fee-rate`, not `case-14`), a `note` when the case is expected to fail today or exists for a known incident, and tags for the area (`fees`, `retrieval`, `refusal`).
- **Size**: start with 20 to 50. Add a case for every real bug found, written before the fix.
- Tell the user plainly which cases you wrote from their documents and which expected values you could not confirm.

This tool does **not** make up cases from nothing. It runs and scores the cases you write together.

## Reading results honestly

- String checks are blunt. "contains 30 days" passes "it is not 30 days". Read the answers of new and failing cases, not only the colour.
- A pass shows that these cases pass. It does not show the bot is right in general; say so when reporting.
- Answers vary. Use `--repeat 3` (or `run.repeat`) before trusting a change in a single case; a case that passes some attempts is **flaky** and counts as not passing.
- Small score changes on a small set are noise. Talk about which cases changed, not about +1.3 points.
- **Model-judged checks** (`judge`) are off by default and marked "model-judged" everywhere. Their scores change between runs and judge models and are not ground truth. Turn them on only when the user asks and has configured a judge endpoint (`judge` in the config, or `--judge`), keep a plain check beside each one, and never call a paid API without the user's go-ahead.

## Files

- `evals.config.json`: `name`, `cases`, `target`, `run` (concurrency, retries, timeoutMs, repeat), `baseline`, `gate` (maxRegressions, maxScoreDrop, maxLatencyIncreasePct, mustPassTag), `judge`, `report`, `runs`.
- A case: `id`, `input` (or `messages` for multi-turn), `expected` (for people), `note`, `tags`, `weight`, `threshold`, `vars` (for request templates), `checks`.
- `runs/<id>.json`: the questions, every attempt's answer, sources, tool calls, latency, tokens and cost, and (after `score`) every check result. Secrets are masked before saving. `score` can be run again on an old run after the checks change; checks are taken from the current cases file by id (`--frozen` keeps the run's own).
- `report.html`: one file, no network, safe to attach to a pull request or send.

## Troubleshooting

- **unreachable** in lint: start the system first, or check the URL and port. `--offline` skips the probe.
- **Every case errors with HTTP 401/403**: the key variable is not set in this shell (`evals check` shows it).
- **The answer is empty but the target answered**: the response path is wrong. Set `target.response.answer` (see `references/targets.md`); the raw run file shows what came back.
- **A source check never passes**: the ids differ (`fees.md` vs `fees`, a URL vs a title). Look at `sources` in the run file and use those ids.
- **Too slow or rate-limited**: lower `run.concurrency`, raise `timeoutMs`.
