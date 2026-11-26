# SillyTavern Headless API v1

Client manual for the versioned SillyTavern Headless API. Use [OpenAPI](openapi.yaml) as the machine-readable contract; this manual explains the behavior clients need to use it.

## Contents

- [Introduction](chapters/introduction.md)
- [Quick Setup](chapters/quick-setup.md)
- [Guide](chapters/guide.md)
- [Native client implementation guide](client-implementation.md)
- [What is missing from the V1 client/API port](what-is-missing.md)
- [Tutorial: preview and send a generation](chapters/tutorial.md)
- [Global Concepts](chapters/global-concepts.md)
- [Endpoint Reference](reference/README.md)
- [OpenAPI schema](openapi.yaml)
- [JSON Schemas](schema/README.md)

## Quick orientation

The companion listens on loopback and authenticates every request with a fresh bearer capability. Start with the [Quick Setup](chapters/quick-setup.md), then check [capabilities](reference/discovery.md) before offering optional features. Use the [generation guide](chapters/guide.md#submit-generations-safely) to handle accepted, interrupted, and uncertain requests safely.

The separate client in `client/` provides a **Presets** page for editing and
importing Chat Completion, context, Instruct and system-prompt JSON. It uses the
existing [named preset endpoints](reference/prompts-and-presets.md): imports
become editable drafts, saving checks the inspected file revision, and activation
is a separate action with active-configuration checks and explicit connection
change consent. The companion continues to serve only the API.

The client now also provides capability-driven character/Persona/group libraries,
active Prompt Manager editing, World Info, macro-variable and regex documents,
chat paging/mutations/sampling, generation previews and recovery, and extension
inventory/scoped settings. Its [isolated extension host](reference/extensions.md)
loads manifest-declared modules, CSS and HTML templates on explicit activation
(up to 4 MiB per UI asset and 4 MiB total source; manifests remain limited to
512 KiB). Module rewriting preserves string-literal boundaries for static
imports, reexports and literal dynamic imports. The host provides distinct
upstream module adapters, ordered frame-local events,
templates, custom dialog controls, i18n, utilities, Prompt/slash command data
models, SSE decoding, scoped settings persistence, named read-only World Info
access and revision-checked native Persona selection with a live avatar ID.
The Persona catalog also returns the revision-bound current `username` (a display
name, not the authenticated handle). The script/context `name1` follows successful
Persona reads/selections before events; `name2` follows the fixed character
snapshot, with source idle-group / initial no-selection names. These exports do
not establish native generation-speaker compatibility.
`resources.providerStatus` adds a no-store, read-only `/provider-status`
observation and an explicit empty-body `/provider-status/check` action. Only a
successful bounded check of the saved provider's model catalog establishes
`Valid`; unverified, failed, pending and invalidated states use `no_connection`.
Observations expire after five minutes, are scoped to the user/current connection,
and never establish generation/model support. The client exposes the check in API
settings; extension startup only reads local status. `/script.js`'s live
`online_status` and context `onlineStatus` receive sequential parent polling at
five-second intervals and publish `ONLINE_STATUS_CHANGED` after binding updates.
Persona catalog access is limited to registered descriptors; upstream avatar
rendering/media and greeting side effects remain unsupported. `reasoning.js`
parses response reasoning using explicit overrides or a scalar settings snapshot.
The frame also provides source-derived `cleanUpMessage` for Chat Completion text
with explicit stopping strings and no required native name stripping or macro
bias expansion, plus pure Markdown/newline/sentence helpers. A named parent read
projects only cleanup switches, bias presence and a bounded context example
separator from the existing settings GET; it never exposes the prompt-bias text
or changes native generation output. Source-derived `baseChatReplace` supports
literal card text and `parseMesExamples` follows upstream example-block rules.
Native macro evaluation and upstream chat DOM globals remain unbound.
`characters` now exposes a deeply frozen native catalog snapshot, bounded to
512 cards, 4 MiB per card response and 16 MiB aggregate, with identity/revision
checks before publication. A conversation host maps `this_chid` and context
`characterId` to the selected catalog index and binds `getCurrentChatId()`;
group hosts bind context `groupId`/`chatId` without selecting a character.
Settings hosts select none. The frame cannot choose its target or mutate this
snapshot; refresh/edit/navigation and full mutable-chat saves remain guarded.
`chat` and `chat_metadata` (also context `chat` / `chatMetadata`) now share a
deeply frozen, complete raw transcript/metadata snapshot from the new read-only
`GET /chats/:chatId/snapshot?characterId=...` or group `.../snapshot` route.
These routes strictly validate one no-follow JSONL file, bounded to 8 MiB and
10000 messages; corruption and overflow fail rather than silently losing rows.
Legacy headerless groups supply empty metadata in memory only. The source
metadata header is excluded from the upstream message array, which uses
zero-based positions; raw text, reasoning, swipes and opaque fields survive.
Settings-only frames retain the source's initial empty no-selection state.
`getLastMessageId` reads this complete snapshot with source swipe/filter rules.
Snapshots stay fixed until extension reload. Their revision is observation only,
and `resources.chatSnapshot` / `groupChatSnapshot` do not enable writes,
generation or full group compatibility.
`printMessages` can redraw the latest native transcript page when an extension
is opened inside a selected conversation. Its parent-only operation waits for
React's DOM commit and scrolling, returns no chat contents and performs no
transcript writes; settings-only hosts reject the call.
Async `saveChatConditional`, `saveMetadata` and `saveChat` exports and context
aliases allow imports but reject every save attempt until mutable chat state
and its transcript persistence lifecycle are bound. These guards issue no
backend request and do not advertise implemented chat saving.
`getContext().saveChat` uses the conditional dispatcher, as upstream. Other
native-only function imports, including `saveCharacterDebounced`, link as
guards that fail before timers or requests; no mutable native globals are
manufactured. Literal-only `substituteParams`/`substituteParamsExtended` and
isolated Handlebars `extractMessageBias` operate locally; macro evaluation and
history/configured-bias lookup remain unbound. `getBiasStrings` supports the
continue/impersonate suppression branch. `stopGeneration` emits only a local
notification and returns `false` without native cancellation or outcome writes.
Conversation-bound `deactivateSendButtons` / `activateSendButtons` asynchronously
acquire/release a session-scoped native send/swipe UI lock. Session abort releases
it; native generation and unresolved-outcome restrictions remain independent.
Settings-only hosts reject, and no provider or persistence request is issued.
The extension `user.js` adapter reads account mode and admin status from the
authenticated session, preserving upstream single-user helper semantics without
granting additional API permissions.
Its `macros.js` legacy custom registry remains local to the settings frame;
registration never installs callbacks in native generation workers.
The `openai.js` adapter supplies local text message/budget classes, safe model
selection and stream response parsing; it never dispatches provider requests.
`preset-manager.js` reads bounded, revision-checked snapshots of the four native
preset kinds, with detached content and connection/credential fields excluded;
selection and preset mutations remain unavailable to the frame.
`extensions/regex/engine.js` supplies local capture/trim replacement and upstream
rule filtering against detached, revision-checked global/active-preset snapshots.
Captured grants gate preset execution; macro-dependent processing, script writes,
scope changes and character/chat binding remain unavailable.
The World Info adapter now reads bounded, revision-checked catalog/settings and
global/extra-character bindings, supplies detached selection/scalar exports, and
converts caller-owned embedded character books with upstream entry defaults.
Budget controls, scanning and native book/settings writes remain unavailable.
Installed extension name/type snapshots preserve upstream local precedence;
they do not load other extensions or grant cross-extension settings access.
Author-note metadata/no-chat behavior, shared runtime constants and Bowser-based
device/time helpers are available; chat-bound author-note injection and upstream
navigation remain unsupported.
`tokenizers.js` supplies local string-length estimates
(`Math.ceil(text.length / 3.35)`), not model tokenization or provider usage.
Slash registration does not implement STscript execution.
Local utility compatibility includes upstream filename sanitization, explicit
avatar-key filename extraction and custom-list icon selection. Default icon
discovery and downloads remain unavailable. The `/script.js` adapter exports
prompt/system-message constants, role lookup, occurrence/parity helpers and lazy
fields without fabricating native chat state or serving upstream avatar paths.
It also re-exports the live Persona avatar ID and captured API kind, initializes
their module dependencies before extension startup, and provides upstream's
`undefined` chat ID when no chat is selected. Parent Persona/settings/identity
operations discard replies after session replacement or abort.
Chat Completion context/response/prompt-limit helpers read the configured numeric
limits from the safe OpenAI settings snapshot; the deprecated `getMaxContextSize`
alias returns the remaining prompt budget. Missing limits and other API kinds
reject. These queries do not tokenize, trim prompts or dispatch generations.
Unused conditional host imports no longer block startup; invoked unsupported
APIs produce compatibility diagnostics. It does not
claim full legacy browser-extension parity. See the [frontend coverage and verification notes](../../../client/README.md)
for supported operations and deliberate limits. Its only local host bootstrap is
`/api/v1/client-connection`; this is not an additional companion API resource.

Explicit privileged [package management](reference/extensions.md#privileged-package-management)
can install, upgrade and remove managed extension/server-plugin files from HTTPS
Git repositories. It is **off by default** (`enablePluginManagement: false`),
with fallback to legacy `enablePackageManagement` when the new key is absent. It
requires operator enablement, administrator access where user flags exist, an
inspected inventory revision and explicit trust confirmation. This is separate
from the isolated extension bridge: it does not grant the iframe management
access, run package scripts/dependency installers, hot-reload code or establish
full plugin compatibility. File changes require a server restart; extensions are
installed/upgraded disabled. Never automatically replay uncertain mutations.

Temporary client extension prompts are advertised separately by
`resources.clientExtensionPrompts`. Character/group preview and generation
inputs accept optional `extensionPrompts`, a data-only map (128 entries, 1 MiB
JSON; values up to 65536 characters) with `value`, `position`, `depth`, `scan`
and `role`. It participates in caller-key identity and existing native macro,
World Info and source prompt assembly; no predicates execute on the backend.
The isolated client resolves frame-local filters before a user submission and
aborts on failure/session replacement. These inputs are transient; see
[extension host details](reference/extensions.md) and the OpenAPI
`ExtensionPromptSnapshot` schema. Full extension lifecycle support remains false.
