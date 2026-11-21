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
7. `POST /api/v1/generations` with a stable `clientRequestId`; persist the returned `requestId`. The caller key is permanently indexed; duplicates return the same generation even after cache expiry or process restart. Reusing a key with a different normalized payload returns 409. `overrides` supplies per-request sampling without exposing credentials or base URLs. `type` supports `normal`, `quiet`, `regenerate` and `continue`.
8. Open `eventUrl` as SSE (`accepted`, `stage`, `token`, `reasoning`, `heartbeat`, `plugin`, `message`, `error`, `done`, `cancelled`). Pass `afterSeq` or `Last-Event-ID` to filter replayed live events. On disconnect, poll `snapshotUrl`; never resubmit automatically.
9. `POST /api/v1/generations/{requestId}/cancel` requests cancellation. While local work is draining the status is `cancelling`; a terminal race or already-dispatched upstream request can have an `unknown` outcome. Inspect the snapshot and wait for `drained:true` before acknowledgement or further mutation.

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
positions 0 (story prompt), 2/3 (before/after Author’s Note), 4 (depth/role),
and 9 (no automatic injection) work. Author-note placements require the
`personaAuthorNote` capability. Persona-specific lorebooks join chat, character,
embedded and global books through the source-derived World Info scanner.

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

Only `main_api=openai` with `chat_completion_source=openai` or `custom` is supported. Source-derived macro engines, World Info scanning and active Prompt Manager ordering assemble the prompt server-side; see the later milestone sections for precise capability boundaries. Advanced macros, Prompt Manager presets, scoped/preset regex, instruct mode, group chats, tools, images, TTS and vectors remain unsupported; chat rename and swipe alternatives are available through the versioned API.

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

### Cancellation through output hooks

The runtime rechecks terminal state after each awaited hook and before saving
transcripts or deferred extension settings. A cancellation observed while an
output/completion hook is suspended cannot become a later transcript write.
The provider may still have billed the generation; this is local commit
exclusion, not a claim that an upstream operation was undone.

Polling/journal text retains complete bounded output instead of silently slicing
at 64 KiB. Oversized transformed text fails explicitly before commit. Quiet
success is `status:done,committed:false`; its result is observable without
inserting a user/assistant row into the chat.

### Durable admission, discovery and caller receipts

A new generation synchronizes its canonical journal and permanent caller-key
index before any provider dispatch. Index/cache eviction does not authorize
another execution. Settings and the matching credential are captured together
for the admitted worker; the captured vault keys live in a private WeakMap, never in
session JSON, prompts, journals, extension contexts or API responses. Later
configuration changes affect future admissions, not the accepted connection.
Failed journal writes are visible and fail closed. Partial output is checkpointed
periodically while work is active, including a solitary chunk followed by a long
pause; an interrupted process restores uncertain work as `unknown` without replay.
Chat files and their parent directories are synchronized before reporting commit.

The companion holds a cooperative process lease in its data root. A fully
prepared nonempty directory is atomically renamed into the claim; Android does
not permit the hard-link variant. Previous PID/start/boot identity is checked
before stale-owner recovery. A live or unverifiable owner prevents startup.
Interrupted lease reclamation is retained for inspection rather than guessed
away. Stop any pre-lease legacy backend before upgrading: the lease does not
fence a noncooperating older process or arbitrary same-UID filesystem writers.

- `GET /generations?characterId=...&chatId=...&limit=1..100&before=...` returns
  scoped metadata pages with `generations`, `hasMore` and `nextBefore`. Add
  `unresolvedOnly=true` for active or unacknowledged uncertain requests. Older
  snapshots remain directly addressable outside the recent in-memory cache.
- `GET /generations/by-client/{clientRequestId}` resolves a lost POST response
  without submitting it again. A 404 means only that no admission is visible at
  that lookup; it does not prohibit a delayed original POST arriving afterward.
- `POST /generations/by-client/{clientRequestId}/abandon`, with the original
  `characterId` and `chatId`, cancels that admitted worker or permanently reserves
  an unadmitted caller key against later execution. It never starts a provider.
- `POST /generations/{requestId}/acknowledge` sends `{expectedSeq}` from the
  inspected snapshot. The exact task must be terminal and locally drained.
  This acknowledges uncertainty and permits another request; it neither replays
  the old prompt nor claims an upstream charge was reversed.

Snapshots include `clientRequestId`, `characterId`, `chatId`, `type`, `seq`,
`drained`, `acknowledged` and `providerDispatched`. New generations, transcript
mutation and character replacement/deletion reject unresolved uncertain outcomes
until inspection/acknowledgement. Cancellation preserves admission until local
hook/provider cleanup has drained. A process stopped after provider dispatch can
still have an unknown upstream billing outcome.

Messenger writes only caller IDs/chat IDs/type into synchronized device-local
no-backup storage before POST. Navigation and activity/process recreation use
read-only discovery/observation, not POST replay. HTTP or observation failures
stop polling until explicit refresh. Missing/unconfirmed admissions can be
reserved/stopped explicitly, even if their character/chat no longer exists.
A separate request manager exposes these receipts; a corrupt local index is
never silently treated as empty. Its explicit reset holds the receipt gate,
verifies a stopped backend and a fresh durable-capable backend before clearing
only local identities; chats, keys and server journals are retained.

### Source-derived native macro evaluation

Prompt preview and dispatch now use the actual upstream legacy macro engine or
Chevrotain macro engine according to `power_user.experimental_macro_engine`.
`scripts/generate-headless-macros.mjs` derives the runtime from the browser
sources; companion packaging checks its source hashes and generated bytes before
emitting a bundle. Regenerate the committed output after changing any listed
upstream source. The adapter provides isolated character/chat/device frames and
bounded variable/output/allocation guards; it does not execute browser plugins
or user-supplied JavaScript.

`GenerationInput.nativeContext` may supply only the composer input, first visible
message index (excluding the JSONL header), mobile flag, locale, time zone and
previously observed generation type. The accepted generation type replaces the
last observed type during actual dispatch. These facts participate in permanent
caller-key identity, so changing them while reusing an admitted key is a conflict.
Clock overrides, extension grants and arbitrary browser globals are rejected.

Preview evaluates local/global variable macros in an isolated frame and returns
`warnings.macroStateChanges` without saving their values. Actual generation saves
variable changes during prompt preparation, before awaited hooks or a provider
request. Like upstream preparation effects, they are not rolled back after a
provider error. Only metadata is saved at this point; an unanswered user row or
replacement reply is still never committed on failure. Global writes merge the
latest unrelated settings and reject a conflicting variable revision. Reading or
observing an admitted generation never reruns its macros. Completed snapshots
expose their preparation warnings at top level as well as inside `snapshot`.

The legacy engine intentionally retains its upstream macro-category execution
order; the new engine retains upstream ordered/nested and lazy-conditional
semantics. Dialogue examples use upstream named `system` messages
(`example_user`/`example_assistant`). Prompt originals are prepared once before
card overrides consume `{{original}}`.

`features.upstreamMacroEngine`, `macroVariables` and `nativeMacroContext` describe
this execution slice. `advancedMacros` remains false: group macro environments and full
Instruct/extension prompt assembly are not yet complete. This change does not establish full presets,
World Info, groups, tools, media or browser-plugin parity.

New-chat creation also uses the saved upstream engine and optional native device
facts. Existing chat IDs and active generations are checked before macro
execution. Greeting text and local variables publish together; global changes are
preparation effects and can precede the transcript. A later filesystem failure
reports an uncertain creation outcome and possible global changes, without an
automatic retry. Greeting diagnostics are stored in the message's
`extra.native_macro_warnings` for the native UI.

Upstream `getCharacterCardFields` eagerly resolves first/alternate greetings
again during later prompt preparation, even when the assembled prompt does not
reference them. Consequently, a variable operation in a card greeting may run
again for an actual generation. Preview only proposes this effect; it does not
save it. This upstream field-resolution behavior is distinct from request replay,
and is covered by source/runtime tests.

### Native variable and engine management

`GET/PUT /api/v1/macro-variables/global` reads/replaces the user-owned global
variable object and saved `experimental` engine choice. Writes require the
inspected `expectedRevision`, complete `variables` object and boolean
`experimental`. The revision includes variables and engine, excluding unrelated
provider settings. A successful save merges the latest unrelated settings and
returns a new revision. Only the variable object is exposed; this is not an
interface to provider credentials or the vault.

`GET/PUT /api/v1/chats/{chatId}/variables?characterId=...` reads/replaces only
that chat's local variable object, with its own inspected revision. It does not
accept an engine/global setting. PUT preserves transcript rows and unrelated
metadata, including independent idle message edits, and rejects active or
unresolved generation admissions. A macro mutation invalidates an old variable
revision. Both APIs replace the complete map; omitting a key deletes that
variable, and `{}` clears the selected map only.

Documents are bounded to 7 MiB serialized UTF-8 so the envelope fits the native
8 MiB response/body contract. Oversized stored state is an explicit error, not a
truncated editable map. Invalid settings JSON/UTF-8/containers and malformed
chat JSONL lines/UTF-8/headers block edits instead of silently replacing data
with defaults or dropping messages. Neither reading nor saving evaluates macros
or calls a model.

Messenger exposes the global editor/engine switch in SillyTavern settings and
the local editor in each chat. A failed save retains the draft and inspected
revision, displays the error, and never automatically retries. Reload explicitly
discards the draft. Native unconfirmed admission receipts fence these writes.
Engine choice affects newly admitted generations; existing admissions retain
their engine snapshot while preparation reads the latest global variables.
The `resources.macroManagement` flag gates these controls separately from full
`features.advancedMacros` parity.


## Source-derived World Info and bounded preparation

`worldInfoScanner` enables the actual upstream scanner: key/secondary matching,
recursion, minimum activations, token budgets, probability, inclusion groups,
sticky/cooldown/delay, field scans, all insertion positions and outlets. Global,
chat, Persona, primary/extra character and embedded books follow source ordering.
WI output uses source-derived regex with scope authorization. Additional storage,
prompt/edit/display paths are described below; full `scopedRegex` stays false
until live-stream and remaining source integration are complete. External extension WI event
hooks remain unavailable; this is not full browser/plugin parity.

Selected files must be regular, non-symlink JSON/UTF-8 books (4 MiB each, 32 MiB
combined). A missing linked primary may use an embedded book; corrupt/unreadable
selections fail visibly. Preparation uses an isolated serialized Worker with a
10-second deadline, 256 MiB old-generation limit, 32-job/64 MiB input queue and
32 MiB result limit. Tokenization uses the actual OpenAI tokenizer with model
downloads disabled. Failure never automatically replays a request. Provider
credentials, URLs and headers remain outside the worker. Cancellation is checked
again after preparation and before effects or provider dispatch.

Preview does not publish variables/timed effects. Upstream preview intentionally
ignores saved sticky/cooldown state, so preview activation may differ from a real
turn. Actual preparation publishes variable/timed metadata before provider
execution. Native book management is described below; full token packing/Instruct and
full regex coverage are still pending.


## Native World Info management

`worldInfoManagement` advertises `/world-info` catalog and `/world-info/{name}`
GET/PUT/DELETE plus `/export`. GET/PUT return `{name,revision,book}`; PUT takes
`{expectedRevision,book}`. Omit/null revision means create only. Imported native
SillyTavern JSON uses the same create endpoint; foreign lorebook formats require
conversion first. The full supplied object, including opaque entry/extension
fields, is retained. Strict UTF-8/JSON, safe names, 4 MiB/20000-entry bounds and a
512-book catalog limit apply. The catalog inspects names/type/size; opening a book
validates its contents. Export returns `{fileName,mimeType,dataBase64}`.

`GET/PUT /world-info-settings` uses `{revision,settings}` on read and
`{expectedRevision,settings}` on write. Only WI settings are replaced; the latest
unrelated provider/Persona settings survive. `world_info.globalSelect` names
global books. `world_info.charLore` contains `{name: characterId,extraBooks:[]}`
records for extra character books. Scan controls are validated; selected files
must exist and be valid before saving. Unknown WI settings survive as supplied.

Primary character links use `data.extensions.world` (legacy cards use
`extensions.world`) through the existing revision-checked card endpoint.
Persona save accepts `lorebook`; an empty string clears it, and selecting/saving
the active Persona updates standard `persona_description_lorebook` state.
`GET/PUT /chats/{chatId}/world-info?characterId=...` reads `{name,revision}` and
writes `{name,expectedRevision}`. Empty name clears the chat link. Chat revisions
exclude unrelated variable/history changes; active or unresolved admissions
block writes. Every transcript row and unrelated metadata field is preserved.

DELETE requires the inspected book revision and refuses referenced books. Remove
all bindings first; deletion never silently changes other documents. Inspection
includes unselected Personas, primary cards, extra character/global bindings,
ordinary chats and group-chat headers. Corrupt/symlink/oversized reference data
blocks deletion. Bounds are 10000 inventory entries, 64 MiB total, 4 MiB/card and
8 MiB/chat. This reference guard does not enable group generation. Import/edit
never authorizes embedded regex, external code or network calls. Native bulk JSON
editors retain failed drafts; only explicit Reload discards them.


## Source-derived native regex paths and scope management

`upstreamRegexPaths` now covers source-derived regex in new user-message storage,
character greetings, provider output/reasoning, prompt history, explicit message
editing/appending and saved-message display. All these evaluations use the bounded
serialized Worker, not a second simplified RegExp implementation. The old native
helper has been removed. Source order is **global → preset → character**. Scoped
scripts require standard `character_allowed_regex`/`preset_allowed_regex` grants.
Flags `promptOnly`, `markdownOnly`, `runOnEdit`, depth, capture trimming, named
captures and raw/escaped macro substitution use the generated upstream engine.

Default user/output scripts run at storage time; `promptOnly` history processing
uses the actual user/assistant placement and source depth (including continue's
prefix depth). Character/story/Persona fields are not passed through user-input
regex. Examples are not user messages. New input is transformed and expanded once,
with staged swipe text kept consistent. Preview uses the same pipeline without
publishing it; random/time values and upstream dry-run WI activation can differ. Existing historical MVP rows are never silently rewritten. If an
old configuration relied on the former incorrect prompt-wide user-regex behavior,
use `promptOnly` with the intended placement instead of relying on that bug.

`GET/PUT /regex-settings` manages `{enabled,scripts,characterAllowed,presetAllowed}`
under its own revision, preserving the latest unrelated settings. PUT takes
`{expectedRevision,settings,confirmScopeChanges}`. Added character/preset scopes
and re-enabling previously granted scopes require a separate explicit `true`
confirmation. Importing or saving a card/preset never grants permission. A grant
is for the named avatar/preset, including future edits; it is not a script digest.
Revocation does not require confirmation. Limits are 1 MiB, 512 scripts and bounded
unique permission lists; malformed stored containers fail instead of becoming
empty authority. Unknown script properties are preserved. Disable only changes
the `regex` entry in disabledExtensions, preserving other extensions.

`GET /chats/{id}?characterId=...&render=true` adds `native_display` and
`native_display_reasoning` while retaining raw `mes`/`extra.reasoning`. Native
clients use `POST /chats/{id}/render` with paging fields, characterId and whitelisted
nativeContext in the body, keeping device facts/drafts out of URLs. Display-only
rules see full-history depth even when paging. Rendering does not call a provider,
rerun prompt preparation, or publish macro-variable effects. A script proposing
such effects produces a visible diagnostic. Native editing uses raw stored text,
not its display projection. Narrator/AI/user and reasoning placements are distinct.
The native UI includes a separate collapsible reasoning block and diagnostics.

Greeting evaluation is asynchronous: identity and admission are rechecked after
waiting and before any effects. Message edit/append snapshots are checked again
after evaluation; newer rows/metadata or a newly admitted generation reject the
stale edit before text or variables are published. Failed drafts remain in the UI.
Any uncertain publication instructs inspection; writes are never auto-replayed.
Provider output processing rechecks cancellation before effects and transcript
commit. A formatting-worker failure after dispatch is billable-unknown, retains
raw provider text and never replays a caller key. Pre-dispatch formatting failures
cannot send a provider request. Worker limits are shared with prompt preparation.

This is not full browser regex/extension parity: live streaming still uses raw
snapshots until the saved-message projection is loaded; full reasoning-in-prompt,
slash-command execution and richer scoped-script management remain open. The
`scopedRegex` full-compatibility flag therefore remains false. The separate
`regexManagement` and `renderedTranscript` resources describe the implemented
surfaces precisely. ST retains ownership of all transcript/configuration state.
