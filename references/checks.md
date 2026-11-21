# Checks

Every case has a `checks` list. A check is an object with a `type` and the fields below. Any check can have a `weight` (default 1).

A case **passes** when every check that ran passes. Its **score** is the weighted share of checks passed (a `contains` with `all` gives part credit). Set `threshold` on a case (0 to 1) to let it pass on score instead, for example `"threshold": 0.75`.

Text is compared after folding case, curly quotes and runs of spaces, unless a check says otherwise.

| type | fields | passes when |
|---|---|---|
| `contains` | `value`, or `all: [...]`, or `any: [...]`; `caseSensitive` | the answer contains the text (all of them, or one of them) |
| `not-contains` | `value` or `any: [...]`; `caseSensitive` | none of the texts is in the answer |
| `regex` | `pattern`, `flags` (default `i`) | the pattern matches somewhere in the answer |
| `exact` | `value`, `ignoreCase` | the whole answer, trimmed, equals the value |
| `json` | `shape` and/or `values` | the answer is JSON (whole text, a fenced block, or the first `{...}`/`[...]`), fits the shape, and has the values |
| `number` | `value`, `tolerance` or `tolerancePct`, `pick` (`any` \| `first` \| `last`) | a number in the answer is within the tolerance of `value` |
| `source` | `id`, `maxRank`, `where` (`retrieved` \| `cited` \| `either`) | the retrieved sources include `id` (in the top `maxRank`), or the answer names it |
| `tool-call` | `name`, `args`, `min`, `max` | the agent called the tool, with arguments like `args` |
| `no-tool-call` | `name`, or `any: [...]`, or nothing (no tool at all) | the tool (or any tool) was not called |
| `refusal` | `expected` (default `true`), `phrases: [...]` | the answer reads as a refusal (or, with `expected: false`, does not) |
| `max-latency` | `ms` | the call took at most `ms` milliseconds |
| `max-length` | `chars` and/or `words` | the answer is no longer than that |
| `judge` | `rubric`, `threshold` (default 0.7) | **model-judged**: a model you configure scores the answer 0 to 1 against the rubric |

## Details

**json shapes.** A type name (`"string"`, `"number"`, `"integer"`, `"boolean"`, `"array"`, `"object"`, `"null"`, `"any"`), with `?` for optional (`"number?"`); an object of shapes; or a one-item list for "a list of these". Extra keys in the answer are fine. `values` maps a path (`"items[0].id"`) to the exact value expected.

```json
{"type": "json", "shape": {"answer": "string", "sources": ["string"], "confidence": "number?"}, "values": {"sources[0]": "fees"}}
```

**number.** Reads every number in the answer (`1,250.5` counts as 1250.5). With `pick: "any"` (the default) the nearest one is used, so "2 dollars a day, 6 dollars in all" passes for 6. Use `pick: "last"` for "the final answer".

**source.** The id is matched without regard to case against `sources[].id` from the target. The result records the rank, which the report shows. `where: "cited"` looks for the id written in the answer (as a word of its own, so `[fees]` or `fees.md` count). Use the ids your system really returns: file names, document ids or URLs.

**tool-call args.** Compared loosely: a string matches when the actual value contains it (any case), or as a regular expression when written `"/^fri/"`. Numbers and booleans must be equal. Objects are compared key by key and extra keys are allowed. A list matches when each expected item matches some actual item.

**refusal.** Looks for common refusal phrases ("I can't", "I'm sorry, but", "outside my scope", "I don't have that information"). Add your bot's own wording with `phrases`. This is a phrase match, not an understanding of the answer.

## The model-judged check

`judge` sends the rubric, the question, the answer and the retrieved passages to an OpenAI-compatible `/chat/completions` endpoint that **you** configure, and asks for `{"score": 0..1, "reason": "..."}`.

- It is **off by default**. Turn it on with `"judge": {"enabled": true, ...}` in `evals.config.json`, or for one command with `--judge`. While it is off, judge checks are reported as skipped and do not count.
- Every result it produces is marked `modelJudged` in the run file and labelled **model-judged** in the report.
- Its score is an opinion of another model. It changes between runs and between judge models, it can be talked round by the answer it grades, and it is not ground truth. Use it for things string checks cannot see (tone, "does not give instructions"), next to at least one plain check, never alone in a must-pass case.
- It costs a model call per check per attempt. A local model server (any OpenAI-compatible one) works.

```json
"judge": { "enabled": false, "baseUrl": "http://localhost:11434/v1", "model": "your-judge-model", "apiKeyEnv": "JUDGE_API_KEY", "timeoutMs": 60000 }
```
