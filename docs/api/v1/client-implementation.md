# Native client implementation guide

This guide describes how a native client, especially Messenger's standalone
Android app, should use the SillyTavern Headless API. The implementation
authority is the versioned `/api/v1` contract and its capability response.
Preserved browser code under `compat-source/upstream/` is useful for behavior
and terminology, but it is not a frontend to load and does not override the
headless contract. The isolated copy at `compat-source/v1-client/` is the
porting workspace; its current contents are still the upstream baseline. Track
unsupported functions and migration status in
[`what-is-missing.md`](what-is-missing.md).

A separate working frontend is maintained in [`client/`](../../../client/README.md).
It references the preserved source behavior while using only V1 resource calls;
it does not execute the copied browser code. Its host-only connection bootstrap
is separate from the public backend contract. See that README for the actual UI
coverage, snapshot-polling recovery, concurrency limits and verification commands.

## Design principles

- Treat the server as the owner of SillyTavern state and behavior. The client
  owns navigation, local drafts, presentation, and recovery UI.
- Discover behavior from `GET /api/v1/capabilities`. Hide or disable features
  whose capability is false or absent. Do not infer support from an upstream
  browser feature, a provider selection, or a plugin manifest alone.
- Keep authentication and provider credentials out of UI WebViews, plugin
  JavaScript, persistent logs, analytics, URLs, and crash reports.
- Treat revisions, generation records, and returned transcript indexes as
  authoritative. Never resolve conflicts by silently overwriting server state.
- Preserve opaque card, preset, settings, and plugin fields when editing a
  document. Do not normalize data just because the native UI does not display
  it.

## Connection and authenticated API client

For the standalone companion, obtain the loopback port and fresh bearer
capability from the companion startup handshake. Keep the capability in
process memory in the native networking layer. Send
`Authorization: Bearer <capability>` on every HTTP request, including reads.
The companion binds to `127.0.0.1`; the client must use loopback and must not
publish or proxy that capability to a remote host. Companion mode does not use
cookies or CSRF tokens. A regular SillyTavern server instead uses its normal
authenticated session, and mutating requests also require the host's CSRF
token.

On connect, call `GET /api/v1/companion/health` and then
`GET /api/v1/capabilities`. Refresh capability discovery after reconnect or
server restart. The bearer value changes on restart. A 401 means the current
capability/session is invalid; reconnect through the host handshake rather
than retrying the request with stale credentials.

Build one API transport that:

1. Adds authentication and `Content-Type: application/json` where appropriate.
2. Applies bounded connection and response timeouts appropriate to each
   operation. Generation event streams need a long-lived read path separate
   from ordinary request timeouts.
3. Parses the standard error envelope and retains the HTTP status, `code`,
   `retryable`, `requestId`, and safe `details` for diagnostics.
4. Never retries a mutation automatically after timeout or disconnect. A
   transport failure does not prove the server did not apply the mutation.
5. Redacts bearer values and any credential-shaped fields from logs.

Use the OpenAPI document for request schemas, size limits, and status codes.
The manual endpoint references explain lifecycle semantics that generated
clients often cannot express.

## Client feature set

### Session and capability driven navigation

Load `/session`, `/settings`, and `/capabilities` after authentication. Use the
session response for the current user identity and server context. A reasonable
top-level navigation is Characters, Groups, Chats, and Settings. Show optional
sections only when the matching resource or feature is available.

Capability fields are granular. For example, group chat rendering and group
generation are exposed separately from `features.groupChats`, which remains
false while complete upstream compatibility is unfinished. A client may expose
the specifically supported group operations if their resource and generation
flags are true, while describing them as a supported subset. It must not label
that subset as full group-chat compatibility.

### Characters, personas, and groups

Use `/characters` to list cards, `/characters/{characterId}` to inspect and
revision-check edits, and the character import/export/avatar routes where
advertised. Keep the card's supplied schema and unknown fields. A card
replacement must include its inspected revision. Avatar replacement uses the
same inspected card revision and must not discard card metadata. Deletion can
also delete associated chats only when the user explicitly selected that
operation.

Use `/personas` to show and edit persona descriptors, and the select route to
change the active persona. Treat persona revisions as independent from
provider settings and preserve unknown descriptor fields.

Use `/groups` and `/groups/{groupId}` for group management. Group chat IDs are
shared across group descriptors, so key client caches and pending actions by
chat ID as well as group ID. Use the group ID returned by discovery when
inspecting an uncertain generation. Group transcript pages, display
projections, preview, sampling, swipe selection, message edits/deletes, and
generation have separate capability flags and lifecycle rules.

### Chats and transcript presentation

Use the character chat list or group chat list to select a chat, then request
bounded transcript pages. Keep raw message text and metadata available to
editing and inspection UI. Rendered transcript endpoints return a display
projection; they are not a replacement for raw transcript data and never
persist rendering effects. Use the returned message indexes for edit, delete,
and swipe operations rather than deriving indexes from a locally filtered
view.

Chat creation can request a greeting. Greeting macros may have variable effects
and can fail after evaluation but before publication; surface the returned
warnings or uncertain outcome and do not resubmit the creation blindly.
Rename, metadata edits, deletion, message changes, world-info bindings, and
sampling edits must respect revision checks and active or unresolved generation
fences. On 409, refresh the relevant resource and ask the user to resolve
conflicting edits.

The current V1 contract does not expose every standard SillyTavern chat
operation. Server/upstream code has chat search and recent-chat listing, chat
import/export, and backup listing/download/deletion, but V1 has no corresponding
routes today. A native client should not call legacy browser endpoints as a
fallback. Track these as API gaps until versioned routes and capabilities are
added.

### Generation composer and controls

Offer normal generation, quiet generation, regenerate, and continue only when
their generation capabilities are true. Before dispatch, allow the user to
inspect a read-only preview. Preview can show the assembled messages or prompt,
provider request fields safe for display, segments, warnings, and token audit.
Never display credentials, endpoint secrets, or custom secret headers.

For every generation, create a unique caller-owned `clientRequestId` and durably
save the ID and target (character/group and chat) before sending the POST. Do
not reuse an ID for a different payload. Once accepted, persist the returned
`requestId`, sequence, status, and event/snapshot URLs. A same-ID lookup is the
recovery operation after a lost response; never submit a replacement request
because the client timed out.

Subscribe to the SSE event endpoint using the returned sequence cursor. Apply
events in sequence order and ignore already-applied sequence numbers. If the
stream disconnects, fetch the snapshot and resume from its latest sequence or
poll until terminal. An SSE stream is only an observation channel: the durable
snapshot is authoritative. Preserve partial output when status is `unknown`.

The UI should distinguish at least these states: preparing, accepted/running,
cancelling, completed, failed before dispatch, cancelled, and unknown outcome.
Unknown means the provider may have processed the request. It is not an ordinary
retryable error. Inspect the exact snapshot and local pending work; acknowledge
the exact terminal sequence only after the client has drained all local
processing. Acknowledgement resolves the observation fence and does not replay
the request.

Cancellation is a request, not proof that the provider stopped. Keep observing
until the server reports a terminal result. Do not let local cancellation hide
a later committed result. On successful generation, refresh transcript pages
from the server. Regenerate retains swipe alternatives; continue updates the
selected swipe. Quiet output has no transcript row and should be presented as
an observation. Usage is provider-reported numeric metadata; absent counts must
remain absent rather than being shown as zero.

When function calling is enabled for an eligible request, the client catalog
describes available client tools but does not authorize their execution. Only a
fresh execution claim with `dispatchAuthorized: true` authorizes dispatch of
that claimed batch. Execute tools locally, then submit one complete ordered
result set with explicit error flags. Duplicate claims are observation only;
exact repeated receipts are idempotent. Persist local execution ownership and
never resume tool execution or provider calls after process restart. Unsupported
tool proposals are observation data, not executable instructions.

### Settings, prompts, presets, macros, regex, and World Info

Use `/settings` for redacted settings reads and supported patches. Treat it as
a scoped editor, not a dump of every upstream browser setting. Provider
credentials use presence-only reads and explicit write/delete routes; render
masked presence indicators and never prefill a credential field with a value.
Deleting a provider credential clears all keys for that source.

The prompt manager editor should operate on its revisioned prompt document and
global order. Preserve unrelated prompt orders and provider settings. Preset
selection can affect active configuration: show the connection-change consent
step when the server requires it, check both file and active-config revisions,
and do not allow selecting a template to enable an unsupported generation
mode. `promptManagerPresets` is false because full macro and Instruct behavior
is incomplete; named preset management is available as its separately
implemented resource.

Macro global and chat-local variables are separate revisioned documents. Show
the saved macro engine choice and preserve drafts on conflict. Reads do not run
macros. Preview does not persist macro side effects; actual preparation may
persist them before provider dispatch. Regex scope grants are authorization:
importing or viewing a script must not silently grant a character or preset
scope. Prompt and text previews are read-only. World Info books/settings/chat
bindings have separate revisions; validate selections and display diagnostics
before saving. Deletion may be rejected when any reference cannot be safely
inspected.

Provider and compatibility indicators must follow the actual capability
document. Chat generation is limited to OpenAI Chat Completions and compatible
custom endpoints. Anthropic Messages, Google AI Studio and other non-OpenAI
wire formats are unsupported. Image/audio input, image generation, TTS,
transcription, translation, and embeddings are not exposed through the Headless
API. Text-completion provider requests and complete Instruct integration remain
disabled. Full tool calling and full group-chat support remain incomplete. Do
not show them as available based on upstream UI controls.

## Plugin support

The word “plugin” covers distinct runtimes. The client should present each
runtime and its support status separately.

### Headless generation extensions

These are server-side SillyTavern extensions declaring `runtime: "headless"`
and optional `beforePrompt`, `afterPrompt`, `onGenerationEvent`, and
`afterGeneration` hooks. The server runs trusted extension code in a bounded
worker when `headlessPlugins` is enabled. Hooks can adjust prompt data and
return bounded prompt insertions, events, settings changes, and quiet prompts.
They receive structured, credential-redacted context. They do not get browser
globals, arbitrary networking, direct filesystem writes, provider credentials,
or authority to dispatch a generation.

The native client should:

- Read `/capabilities` and `/extensions`, show whether hooks are enabled, and
  display extension runtime classification and diagnostics.
- Read and patch an extension's settings only when `extensionSettings` is
  available. Use merge semantics, preserve other namespaces, and report a
  failed save rather than leaving an optimistic value silently committed.
- Treat hook effects and warnings as server-owned generation results. Do not
  run those hooks a second time in the client.
- Explain that enabling headless hooks runs trusted server extension code.
  Installing or importing an extension must not silently enable it.

### WebView UI extensions

The API V1 extension shell is a compatibility UI for extension settings. It
does not provide the full browser application or a general ST context. A native
host should open it only in an isolated WebView and should label missing APIs
explicitly. The shell exposes a small `SillyTavern.getContext()` shim and
extension settings persistence. Its generation, template rendering, macro,
slash-command, and tool-registration methods are unavailable or no-ops.

For an Android-owned extension host, follow
[`android-extension-host.md`](../../android-extension-host.md): keep the bearer
capability in native code, never JavaScript; use a narrow authenticated
dispatcher; validate extension asset paths; block arbitrary navigation and
network access; bound RPC frames and deadlines; and never replay a mutation
after disconnect. Plugin-facing calls must be named operations, not arbitrary
access to Android objects or the authenticated HTTP client.

### Virtual DOM and server plugins

The virtual DOM adapter runs selected extension code in an isolated worker and
returns a bounded HTML/text fragment. It does not calculate CSS layout or
provide a full browser. Sanitize output before rendering and show adapter
diagnostics. Server plugins are trusted Node code that can add server routes;
they are not client plugins and must not be installed or invoked through a
general-purpose client bridge.

`GET /compat/extensions` is the compatibility inventory for extension
manifests, requirements, adapter support, and diagnostics. Requirements and
manifest claims are not proof that every API an extension uses is implemented.
Offer a compatibility screen that lists each extension's runtime, required
capabilities, supported adapter methods, and known missing methods before
activation. Keep extensions isolated from one another and from credentials.

## State and recovery model

Maintain a small local state store for the active connection, capability
document, selected character/group/chat, revision tokens, unsent composer text,
and pending generation identities. Cache data only as an optimization; always
reconcile it with the server after reconnect. Store pending generation IDs
before network dispatch so process death does not erase the only recovery key.

After reconnect:

1. Reauthenticate and refresh capabilities/session.
2. Resolve every locally pending generation by `clientRequestId` before
   starting another generation for the same target.
3. Refresh active chat pages and relevant revisions.
4. Show unresolved or uncertain outcomes for inspection. Never auto-acknowledge
   them and never repeat a provider request.

Use separate loading/error states per resource. A failure to load one optional
panel should not discard the active transcript or composer draft. For 409
conflicts, reload and present the server and local versions for an explicit
choice. For 422 integrity or validation errors, retain the user's draft and
show the server diagnostic. For 503 journal/storage errors, stop generation
admission and preserve recovery state.

## Known API gaps for client planning

The normal SillyTavern server and preserved upstream client implement
search/recent chat discovery, chat import/export, and chat backup access, but the
current `/api/v1` contract does not. These should be added as versioned API
resources with bounded input/output, capability flags, and tests before the
native client offers them. The client must not use legacy browser routes to
fill those gaps.

Other upstream features may be browser-only, extension-specific, or explicitly
incomplete in the headless implementation. Use the capability document and API
references as the release contract rather than treating this list as an
implicit parity promise.

## Implementation order

1. Build and harden the authenticated transport, capability discovery, and
   error model.
2. Implement character/group/chat browsing, paged raw transcripts, and
   read-only rendered projections.
3. Implement preview, generation streaming, durable caller IDs, disconnect
   recovery, cancellation, and uncertain-result inspection before adding
   generation controls to the main composer.
4. Add revision-based editing for personas, cards, settings, presets, prompts,
   regex, macro state, and World Info.
5. Add capability-gated group workflows and client tool batches with durable
   local execution claims.
6. Add plugin inventory and explicit adapters one runtime at a time. Validate
   adapter coverage and diagnostics before enabling any extension UI.
7. Add search/import/export/backups only after the V1 API gains the required
   endpoints and capability flags.

When migrating an upstream function, read this guide and the matching endpoint
reference first. Update the gap matrix in `what-is-missing.md` in the same
change. Do not leave legacy-route fallback behavior in the copied client.

## Source map

- Contract and route implementation: `src/endpoints/api-v1.ts`.
- Machine-readable contract: `docs/api/v1/openapi.yaml`.
- Client behavior references: `docs/api/v1/reference/` and
  `docs/api/v1/chapters/`.
- Generation ownership and recovery: `src/headless/generation-store.ts`,
  `src/headless/generation-journal.ts`, and
  `src/headless/runtime.ts`.
- Headless extension runtime: `src/headless/plugin-runtime.ts` and
  `src/headless/plugin-context.ts`.
- Preserved upstream behavior authorities: `compat-source/upstream/scripts/`.
