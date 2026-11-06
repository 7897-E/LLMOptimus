# LLM Optimus

This folder runs two local models behind one automatic OpenAI-compatible router:

- `general`: Qwen 3 4B Thinking for chat and reasoning
- `coder`: Qwen2.5-Coder 1.5B Instruct for code chat, edits, and apply

Malformed tool-call JSON is repaired by a bounded, JSON-only request to the
instruction-tuned Coder model. The base autocomplete checkpoint is intentionally
not used because it continues text rather than reliably following repair instructions.

## Run

Double-click `Run.bat`, wait for the `router listening` message, and open:

- Smart web app: `http://127.0.0.1:8082/`
- Smart OpenAI-compatible API: `http://127.0.0.1:8082/v1`

Use model `auto` in API requests. The router sends implementation, debugging,
refactoring, and test-writing tasks to Coder. It sends conversation, explanation,
reasoning, and factual research to General. You can still force `general` or
`coder` with the request's `model` field or the web app selector.

Streaming requests (`"stream": true`) use Server-Sent Events (SSE). Upstream SSE
tokens are forwarded as they arrive, including short replies. If a model server
returns a regular JSON completion instead, the router converts it to a valid
single-event SSE response; that fallback cannot provide token-level streaming
because the upstream response was not streamed. Text-form tool calls remain
buffered until validated so their raw call payload is not shown to the client.
Tool-call turns are executed internally, then the resulting answer continues
streaming. Short activity lines such as `Reading file…`, `Editing file…`, and
`Running command…` are streamed while tools execute.

## VS Code and OpenAI-compatible clients

Configure an OpenAI-compatible **Chat Completions** provider with:

- Base URL: `http://127.0.0.1:8082/v1`
- Model: `auto`, `general`, or `coder`
- Streaming: enabled
- API key: not required by the router; use a placeholder only if the extension
  requires a non-empty value

Some extensions ask for the full endpoint rather than a base URL; use
`http://127.0.0.1:8082/v1/chat/completions` in that case, and avoid appending
`/chat/completions` twice. `GET /v1/models` lists the three model IDs. The router
implements chat completions, not the legacy `/v1/completions` or newer
`/v1/responses` APIs, so choose an extension/provider that supports OpenAI-style
Chat Completions.

| Status | Feature |
|---|---|
| Improved | General and Coder chat streaming, including short replies and upstream JSON fallback |
| Preserved | Automatic model routing, web search, tool execution/approvals, and llama-ui integration |
| Supported | OpenAI-compatible Chat Completions and model discovery for compatible VS Code extensions |
| Not supported | Legacy text completions and the `/v1/responses` API |

Web search runs automatically for explicit searches and time-sensitive prompts
such as news, weather, prices, schedules, current versions, or current office
holders. Set the nonstandard request property `web_search` to `true` or `false`
to override automatic detection. Search-backed non-streaming responses always
include a source list.

`GET /v1/tools` exposes the router's OpenAI-compatible tools, including
`web_search` and the toolchain-aware `run_file`. `run_file` directly supports common
scripting runtimes and compile-and-run flows for C, C++, Rust, C#, Java, and
Kotlin when their toolchains are installed. Llamafile's unrestricted built-in executor remains disabled, but
the router exposes llama-ui-compatible native schemas and an execution adapter at
`/tools`. This preserves llama-ui's tool cards and permission prompts while all
file paths and commands execute through the project-scoped router. The router's
OpenAI-compatible schemas remain available at `/v1/tools`.

The read-only `workspace_inspection` tool provides a bounded project overview in
one call: a depth-limited tree, important root files, detected languages, and a
configurable README preview. All output is calculated by the router; the model
cannot supply or fabricate inspection results.

## Tool safety

The folder containing `Run.bat` is the default tool workspace. Reads, directory
inspection, and searches inside it run automatically. Writes and edits are
labelled Medium risk; execution and recoverable deletion are High risk. Every
changing or executing action carries a router-calculated short summary, risk
level, reason, resolved target, and one-time approval binding. Executed code is
explicitly identified as inheriting the current Windows user's access.

Paths that resolve outside the workspace, including symlink escapes, are wrapped
as Critical `approved_external_action` calls and require explicit approval in
llama-ui. Risk labels are informational, so Critical actions may still be
approved. Native mutations require a router-issued, exact-action, single-use
approval token by default. The HTTP boundary rejects non-loopback Host headers,
cross-origin browser requests, and non-JSON state-changing requests. Runtime
approval disabling is locked unless the launcher explicitly opts into the unsafe
test override. Tool logs omit file contents and full shell commands.

This remains an informed-consent layer, not an OS sandbox: approved programs run
with your Windows user permissions. Deletes are moved into `.llmoptimus-trash`
when possible. Web search
does not access local files and does not require file-access approval.

Run the regression suites after router or tool changes:

```powershell
node router.security.test.js
node router.test.js
```

The underlying diagnostic endpoints remain available at:

- General API/web: `http://127.0.0.1:8080/`
- Coding API/web: `http://127.0.0.1:8081/`

You can also double-click `Run.bat` as before. From a terminal, choose a profile:

```powershell
.\Run.bat            # balanced default: 128 thinking tokens
.\Run.bat deep       # harder planning/debugging: 512 thinking tokens
```

## Performance profile

The launcher is tuned for a 16 GB, 6-core/12-thread laptop:

- 32,768-token General context for Copilot Agent tools and an 8,192-token Coding context
- one request slot instead of four competing slots
- compressed key cache and automatic Flash Attention when the hardware supports it
- prompt caching for repeated editor context
- task profiles that cap reasoning/output at 128/1,024 (balanced) or
  512/2,048 tokens (deep)
- eight inference threads, benchmarked as the fastest setting on this CPU

The launcher keeps both models warm for low latency. JSON repair is called only
when deterministic tool-call parsing and schema validation fail. It uses a strict
system instruction, JSON response formatting, a finite output limit, and only the
schema for the intended tool. Stopping the visible router also stops both model
servers.
