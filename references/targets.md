# Targets

The `target` in `evals.config.json` says how to ask the system a question. Four types are built in. Each returns, per case:

```
{ answer, sources: [{ id, text?, score? }], toolCalls: [{ name, arguments }], usage: { inputTokens?, outputTokens?, cost? } }
```

Only `answer` is required. `sources` feed the `source` check and the passages panel, `toolCalls` feed the tool checks and the trace, `usage` feeds the token and cost figures (shown only when the target reports them).

**Keys.** Write `${NAME}` in a URL, header or body, or name a variable in `apiKeyEnv`. Values are read from the environment when the case runs and are never written to a run file or report. Run files and reports are also passed through a redactor that masks common key formats, `Bearer ...` values, `password=...` style pairs, URL passwords and the value of every environment variable whose name contains KEY, TOKEN, SECRET or PASSWORD. It catches obvious secrets, not every secret: do not put customer data in cases you share.

## http

```json
"target": {
  "type": "http",
  "url": "http://localhost:3000/api/chat",
  "method": "POST",
  "headers": { "authorization": "Bearer ${BOT_API_KEY}" },
  "body": { "message": "{{input}}", "sessionId": "eval-{{id}}", "history": "{{messages}}" },
  "response": { "answer": "data.reply", "sources": "data.citations", "sourceId": "doc_id", "sourceText": "snippet", "toolCalls": "data.steps", "toolName": "tool", "toolArgs": "input" }
}
```

- Slots: `{{input}}` (the question), `{{id}}` (the case id), `{{vars.name}}` (from the case's `vars`), `{{messages}}` (the case's `messages`, or one user message). A string that is only a slot keeps the slot's type, so `"{{messages}}"` sends the list itself.
- `GET` sends no body; put `{{input}}` in the URL (it is URL-encoded).
- Without `response`, common names are tried: `answer`, `output`, `text`, `response`, `content`, `message`; `sources`, `documents`, `contexts`, `citations`; `toolCalls`, `tool_calls`; `usage` (OpenAI and Anthropic-style token names). A plain-text response is the answer.
- `response.inputTokens`, `outputTokens` and `cost` take paths too.
- `lint` checks that something answers at the URL's address.

## openai (any OpenAI-compatible chat endpoint)

```json
"target": {
  "type": "openai",
  "baseUrl": "http://localhost:8080/v1",
  "model": "your-model",
  "apiKeyEnv": "OPENAI_COMPATIBLE_KEY",
  "system": "You answer questions about the handbook only.",
  "temperature": 0,
  "tools": [ { "type": "function", "function": { "name": "reserve_tool", "parameters": { "type": "object" } } } ],
  "price": { "inputPerMTok": 0.5, "outputPerMTok": 1.5 },
  "extra": { "max_tokens": 400 }
}
```

Posts to `{baseUrl}/chat/completions`. Tool calls in the reply are recorded (their JSON arguments parsed). Tokens come from `usage`; cost is computed only when you give `price` (per million tokens). Leave out `apiKeyEnv` for a local server with no key. This tests the bare model with your prompt; to test your whole app (retrieval included) use `http` or `module`.

## command

```json
"target": { "type": "command", "command": "python3 ask.py" }
"target": { "type": "command", "command": "python3", "args": ["ask.py", "--id", "{{id}}"], "input": "json", "output": "json", "response": { "answer": "reply" } }
```

The question is written to stdin and the answer read from stdout. With `"input": "json"` stdin gets `{ input, id, vars, messages }`. With `"output": "json"` stdout is parsed and mapped like an http response. A non-zero exit code is an error, and the end of stderr is recorded. With `command` alone the string runs through the shell; with `args` it does not, which is safer when slots are used.

## module

```json
"target": { "type": "module", "path": "./target.mjs", "export": "answer", "options": { "variant": "b" } }
```

Imports the file and calls `fn(input, { id, vars, messages, options, signal })`. Return a string or the object above. The quickest way to test a JavaScript system directly, or to wrap a client library.

## Run settings

```json
"run": { "concurrency": 4, "retries": 1, "timeoutMs": 30000, "repeat": 1 }
```

- `concurrency`: cases asked at once. Mind the target's rate limits.
- `retries`: extra tries after an error or timeout (with a short back-off). A wrong answer is not retried.
- `timeoutMs`: per call. A timed-out call is stopped (the request is aborted, the command is killed).
- `repeat`: ask every case N times. A case that passes some times and fails others is **flaky**; it counts as not passing, and the report shows each attempt.

## Adding a target type

Write a factory in `engine/lib/adapters/` that returns `{ call(case, { signal }), probe(), describe(), envNames }`, and add it to `adapters/index.mjs`. `describe()` must not include secrets: it is saved in every run file.
