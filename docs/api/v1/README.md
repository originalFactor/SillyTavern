# SillyTavern API v1

This directory contains the opt-in, versioned contract for non-HTML clients such as Jetpack Compose. It is a fork-specific extension; the legacy `/api/*` endpoints remain private SPA internals.

## Enable

Set `api.v1.enabled: true` in `config.yaml` or `SILLYTAVERN_API_V1_ENABLED=true`, then restart SillyTavern.

Headless plugin hooks are a **separate, additional** opt-in: set `api.v1.headlessPlugins: true` (or `SILLYTAVERN_API_V1_HEADLESSPLUGINS=true`). Only enable it when every installed `runtime: headless` extension is trusted. Hooks run in an isolated Node Worker with a bounded `SillyTavern.getContext()` shim, a configurable timeout (`api.v1.headlessPluginTimeoutMs`, default 5000 ms) and no access to cookies, secrets or the Express request.

## Client flow

1. Open `/login` in a platform WebView when user accounts, Basic Auth or SSO are enabled. Reuse its persistent cookie jar for all API calls. With accounts disabled, no login WebView is required.
2. `GET /csrf-token`; send `X-CSRF-Token` on every non-idempotent request and on the SSE fetch if the HTTP client permits custom headers.
3. `GET /api/v1/capabilities`; show unsupported features explicitly. Do not fall back to private SPA endpoints. `features.serverPlugins` now reflects the real `enableServerPlugins` config, and `features.headlessPlugins` / `features.headlessHooks` report the plugin tier.
   The native companion may use `/api/v1/provider-credentials` to save an OpenAI/custom key or delete all stored keys for that provider. Reads return presence flags only; key values are never returned by the API.
4. Read `GET /api/v1/characters`, `GET /api/v1/characters/{characterId}/chats`, and `GET /api/v1/chats/{chatId}?characterId=...`. IDs are filenames without extensions; messages are ST JSONL objects with an added `index` field. Use `limit`, `before` and `after` to page; the response carries `total`, `hasMore` and `nextBefore`.
5. Create a chat with `POST /api/v1/characters/{characterId}/chats` (`chatId`, optional `firstMessage`). Rename it with `PATCH /api/v1/chats/{chatId}` (`characterId`, `newChatId`), edit history with `POST /api/v1/chats/{chatId}/messages` (`append` / `edit` / `delete` by `index`) and remove it with `DELETE /api/v1/chats/{chatId}?characterId=...`.
6. Optionally call `POST /api/v1/generations/preview` to inspect prompt segments and the derived `providerRequest`. It never contacts a model provider.
7. `POST /api/v1/generations` with a stable `clientRequestId`; persist the returned `requestId`. A duplicate request within five minutes returns the same generation. `overrides` supplies per-request sampling without exposing credentials or base URLs. `type` supports `normal`, `quiet`, `regenerate` and `continue`.
8. Open `eventUrl` as SSE (`accepted`, `stage`, `token`, `reasoning`, `heartbeat`, `plugin`, `message`, `error`, `done`, `cancelled`). Pass `afterSeq` or `Last-Event-ID` to filter replayed live events. On disconnect, poll `snapshotUrl`; never resubmit automatically.
9. `POST /api/v1/generations/{requestId}/cancel` is best-effort. A terminal race returns `outcome: "unknown"`; surface it to the user.

The chat JSONL is written **once, atomically, at successful completion**. A failed or cancelled generation leaves no unanswered user row on disk. In-flight records are journalled to `api-v1-generations/` under the user root and restored as `unknown` after a server restart — they are never replayed automatically.

Regenerating preserves the old assistant reply in `swipes` and selects the new
reply with `swipe_id`. To switch, post `action: "swipe"`, the message `index`
and a zero-based `swipeId` to the messages endpoint. Continue updates the selected
alternative without discarding others. Chat/message mutations and rename/delete
return 409 while a generation for that chat is active.

## Kotlin DTO sketch

```kotlin
@Serializable data class Capabilities(val version: String, val enabled: Boolean)
@Serializable data class GenerationInput(
    val characterId: String,
    val chatId: String,
    val clientRequestId: String,
    val type: String = "normal",
    val input: String = "",
    val stream: Boolean = true,
    val overrides: SamplingOverrides? = null,
)
@Serializable data class SamplingOverrides(
    val model: String? = null, val temperature: Double? = null, val maxTokens: Int? = null,
    val topP: Double? = null, val stop: List<String>? = null,
)
@Serializable data class GenerationAccepted(
    val requestId: String,
    val status: String,
    val seq: Long,
    val snapshotUrl: String,
    val eventUrl: String,
    val cancelUrl: String,
)
@Serializable data class ApiErrorBody(val error: ApiError)
@Serializable data class ApiError(
    val code: String,
    val message: String,
    val retryable: Boolean,
    val requestId: String,
)
```

Use `Content-Type: application/json` for JSON requests and `application/merge-patch+json` (or `application/json`) for `PATCH /settings`. Keep DTOs non-reflective or add R8 keep rules.

## Native character cards and personas

`POST /characters` accepts a caller-owned `characterId` and the opaque `card`
object. `POST /characters/import` accepts `characterId`, `format: json|png`,
and canonical `dataBase64` file bytes. JSON is limited to 1 MiB and PNG/APNG to
4 MiB including metadata. V1/V2/V3 schema, unknown extension fields and embedded
lorebooks survive editing and export. `GET /characters/{id}` returns `raw`,
normalized `data`, and a SHA-256 `revision` of the PNG. `PUT /characters/{id}`
requires the inspected `expectedRevision`; it preserves the existing image and
rejects stale writes with 409. `GET /characters/{id}/export?format=json|png`
returns `{fileName,mimeType,dataBase64}` for a native save picker. Deletion
requires the revision and, when chats exist, explicit `deleteChats=true`.
Admitted generations fence card replacement/deletion across all its chats.
CHARX, WebP card imports and auxiliary asset transfer remain unimplemented.

`GET /personas` returns `{personas,selectedId,revision}`. Writes to
`PUT /personas/{id}`, `POST /personas/{id}/select` and
`DELETE /personas/{id}?expectedRevision=...` use that persona-only revision,
preserve unrelated provider settings, and use standard `power_user.personas`,
`persona_descriptions`, `user_avatar` and `username` fields. New IDs end in
`.png`; a packaged default avatar is created. Selection applies to subsequent
requests; existing transcript names/text are not rewritten. Description
positions 0 (story prompt), 4 (depth/role), and 9 (no automatic injection) work;
author-note placements 2/3 explicitly reject instead of silently degrading.
Persona-specific lorebooks join global books under the existing simplified
World Info matcher. Full World Info and author-note parity remain separate work.

## Extensions and WebViews

`GET /api/v1/extensions` classifies manifests by optional fields:

```json
{
  "runtime": "headless|webview|legacy",
  "entry": "index.mjs",
  "ui": "settings.html",
  "capabilities": ["beforePrompt"],
  "hooks": {"beforePrompt": "onBeforePrompt"}
}
```

- `headless`: trusted Node ESM hooks, disabled unless `api.v1.headlessPlugins: true`. See below.
- `webview`: open `shellUrl` in a same-origin WebView. The shell now serves the extension's own `settings.html` (including `local` user-installed extensions), exposes working `eventSource` / `eventTypes` / `extensionSettings` / `writeExtensionField` / `getRequestHeaders` members, and persists settings through `PATCH /api/v1/extensions/{id}/settings`. Privileged generation APIs reject explicitly instead of silently failing. Native code injects no provider keys; it must post the CSRF token into the shell with a `csrf-token` message.
- `legacy` (default): the shell serves the extension UI where present and otherwise explains that the complete `/` SillyTavern WebView is required. It no longer returns a bare `422`.

### Authoring a headless extension

A headless extension is a plain ESM module under the user's `extensions/<name>/` directory with `runtime: headless`, an `entry`, and a `hooks` map. Exported hook names must match the manifest values:

```javascript
// extensions/my-ext/index.mjs
export async function beforePrompt(context) {
    context.messages.push({ role: 'system', content: 'Always answer in haiku.' });
}
export async function afterPrompt(context) {
    context.setExtensionPrompt('footer', 'Signed: my-ext', 1);
}
export async function onGenerationEvent(context) {
    await context.eventSource.emit(context.eventTypes.MESSAGE_RECEIVED, { text: 'hello' });
}
export async function afterGeneration(context) {
    context.generation.text = context.generation.text.replaceAll('bad', 'good');
}
```

```json
{
  "display_name": "my-ext",
  "version": "1.0.0",
  "runtime": "headless",
  "entry": "index.mjs",
  "hooks": {
    "beforePrompt": "beforePrompt",
    "afterPrompt": "afterPrompt",
    "onGenerationEvent": "onGenerationEvent",
    "afterGeneration": "afterGeneration"
  }
}
```

Hooks run in this order: `beforePrompt` → `afterPrompt` (both may mutate `context.messages`; **the mutations are applied**), then the provider call, then `afterGeneration` (may rewrite `context.generation.text` or return a string). `onGenerationEvent` receives lifecycle events `generation_started` / `generation_completed`.

The shim provides a deliberately limited `SillyTavern.getContext()`:

| Member | Behaviour |
| --- | --- |
| `messages`, `chat`, `chatMetadata`, `characters`, `settings`, `extensionSettings`, `eventTypes`, `eventSource`, `generation` | Read-only state (settings are credential-redacted) |
| `setExtensionPrompt(key, value, position, depth, role)` | Injects a bounded system/user/assistant prompt |
| `writeExtensionField` / `writeExtensionFieldBulk` | Persists a scoped settings delta back to user settings |
| `eventSource.emit` | Emits a bounded `plugin` SSE event (allow-listed names only) |
| `getRequestHeaders()` | Returns `{ 'Content-Type': 'application/json' }` only — never credentials |
| `renderExtensionTemplateAsync` | Reads a bounded local template with `{{key}}` substitution |
| `substituteParams` / `substituteParamsExtended` | Basic macro expansion |
| `generate`, `sendStreamingRequest`, `generateRaw`, `generateQuietPrompt` | Reject or queue a bounded effect; no provider access from the worker |
| Chat mutations (`addOneMessage`, `deleteMessage`, `saveChat`, …) | Reject with a visible warning — the generation runtime owns the JSONL |

A throwing or timing-out hook is isolated: it produces a warning in `pluginEffects.warnings` and the turn continues. Worker `result.context` is applied by the host, so `beforePrompt` / `afterPrompt` changes are never silently dropped. Plugin effects also appear as `plugin` SSE events and in the generation snapshot.

### Trust boundary

Headless extensions are **not sandboxed against Node** — they run as ESM in a Worker with filesystem access via `import('node:fs')`. The Worker isolation, timeouts, credential redaction and effect allow-list are containment, not a security sandbox. Only install `runtime: headless` extensions you trust, and keep `headlessPlugins: false` otherwise. Never put provider keys, Cloud tokens or arbitrary network grants into extension settings.

## MVP limitations

Only `main_api=openai` with `chat_completion_source=openai` or `custom` is supported. Basic `{{char}}`/`{{user}}` macros, global World Info books, embedded character books, global regex scripts and static system/story/jailbreak prompts are assembled server-side. Advanced macros, Prompt Manager presets, scoped/preset regex, instruct mode, group chats, tools, images, TTS and vectors remain unsupported; chat rename and swipe alternatives are available through the versioned API.

See `openapi.yaml` and `schema/*.json` for the machine-readable contract, and `tests/api-v1-plugins.test.js` for the headless plugin compat-layer tests.

## Companion mode (native Messenger front-end)

`src/headless-companion.js` is a **separate, minimal entry point** for the
optional `cc.ptoe.messenger.stbridge` Android app. It is NOT the full ST server:
it mounts only `/api/v1`, binds strictly to `127.0.0.1`, and requires a 32-byte
bearer capability on **every** request (including GET). There is no SPA, no
static file serving, no cookie/CSRF login flow and no CORS. Provider keys stay
in `secrets.json` and never enter a response.

```bash
node src/headless-companion.js --dataRoot <dir> --port 0 --token <64-hex>
```

- It writes a companion-owned `config.yaml` next to the data root (v1 enabled,
  accounts/basic auth off, loopback whitelist) BEFORE importing any ST module,
  because several modules read config at evaluation time.
- It emits one machine-readable handshake line on stdout:
  `{"type":"companion_ready","port":<ephemeral>,"token":"<hex>"}`. The
  companion APK reads that line and passes `port` + `token` to Messenger over a
  signature-protected AIDL service. The token is regenerated on every start and
  is never persisted or logged.
- `capabilities.auth` reports `bearerToken: true` / `cookieSession: false` /
  `csrf: false` in this mode (`SILLYTAVERN_COMPANION_MODE=true`).
- `GET /api/v1/companion/health` is a capability-gated readiness probe.
  Everything outside `/api/v1` returns 404.

`scripts/build-companion-bundle.mjs --out <dir>` produces the minimal 38-file
server-side bundle (static + dynamic import graph walk, packaged defaults,
tokenizer data, and the URL-loaded plugin worker) with a verified
`companion-bundle.json` manifest. The Messenger `:stbridge` module's
`build-payload.mjs` consumes it, adds the transitive production-only
`node_modules` tree offline (preserving nested conflicting versions), and pairs
it with a pinned static-PIE Android Node executable shipped as
`jniLibs/<abi>/libnode.so`. See the Messenger repo's `stbridge/AGENTS.md`.

Validation: `tests/api-v1-companion.test.js` (boot + auth gating + capabilities
+ settings round-trip) and `tests/api-v1-bundle.test.js` (bundle contents,
exclusions, determinism).

### Active Prompt Manager configuration

`GET /api/v1/prompt-manager` returns `{revision,prompts,order}`. A scoped
`PUT /api/v1/prompt-manager` sends `{expectedRevision,prompts,order}`; it preserves
provider/model settings, opaque prompt fields and unrelated prompt orders, and
rejects stale/missing revisions with HTTP 409. Limits are 128 prompts/order
entries and 512 KiB. This is the active configuration, not named preset storage.

Preview and generation share ordering, enable switches, marker insertion,
system/user/assistant roles, generation triggers, depth/priority injections and
character-card main/post-history overrides (`forbid_overrides`, `{{original}}`).
Global ID 100001 takes priority; legacy 100000 migrates with the persona marker
included. Unknown references in existing imported orders are skipped as upstream
does; new native edits must reference existing unique prompts. Depth injections
require an enabled chat-history marker. Quiet prompts remain last. Existing
limited World Info/regex and message-example parsing still apply; these changes
do not establish their full upstream semantics. Named presets, Instruct mode,
full macro semantics and token-budget packing remain incomplete.

Capabilities expose `resources.promptManager` and
`features.promptManagerOrdering`; `features.promptManagerPresets` stays false.

### Provider completion and privacy boundary

Native provider dispatch follows no redirects and performs no automatic retries.
An HTTP 200 alone or a socket EOF does not establish success: SSE must contain a
terminal `[DONE]` or recognized completion reason. Interrupted, malformed,
oversized or transport-ambiguous streams become `unknown`; their partial text
stays in the observation journal and is never saved as an assistant chat row.
Explicit provider errors retain HTTP status/detail with credentials redacted.

Error detail is bounded to 8 KiB/3 seconds, events to 1 MiB, the total SSE stream
to 16 MiB and output text/reasoning to 8 MiB. Dispatch has a five-minute deadline;
timeout does not prove the upstream operation stopped and never authorizes a
replay. Unsupported tool calls fail visibly without execution. Usage contains
only numeric metadata. Settings and preview responses hide credential fields
(including custom headers) while stored values stay unchanged.

### Named preset storage and selection

`GET /presets/{kind}` lists built-in and user presets with individual file
revisions, the current name and `activeRevision`. Kinds currently exposed are
`chat-completion`, `context`, `instruct` and `sysprompt`. Built-in templates ship
in the companion bundle; the browser SPA is not required. User files override
same-named built-ins without modifying the bundled original.

- `GET /preset-settings/{kind}` snapshots active settings using upstream preset
  field names (for example `temperature`, not internal `temp_openai`).
- `GET /presets/{kind}/{name}` reads portable JSON plus origin, revision,
  credential-redaction notice and pending connection-field changes.
- `PUT /presets/{kind}/{name}` accepts `{preset,expectedRevision?}`. Creation
  must not overwrite an existing name; replacing an inspected user/built-in
  preset needs its exact revision. JSON is bounded to 1 MiB. Unknown fields are
  preserved; malformed prompt orders and credential-bearing imports are rejected.
- `POST /presets/{kind}/{name}/activate` requires `{expectedRevision,
  expectedActiveRevision,allowConnectionChanges?}`. Provider/model/connection
  changes require explicit `allowConnectionChanges:true`; stale file or active
  settings fail with 409. OpenAI and custom sources remain the supported runtime
  providers. Legacy main/nsfw/jailbreak prompt fields migrate on selection.
- `GET /presets/{kind}/{name}/export` returns the standard base64 JSON export
  envelope without credentials. Dedicated provider settings retain their keys.
- `DELETE /presets/{kind}/{name}?expectedRevision=...` deletes only an inspected,
  inactive user preset. Removing an override reveals the bundled original.

The preset/settings alias map is checked against upstream `settingsToUpdate`.
Template selection does not enable Instruct mode. Storage/selection does not yet
establish full macro, World Info or token-budget semantics; the full Prompt
Manager parity capability remains false while those requirements are open.
