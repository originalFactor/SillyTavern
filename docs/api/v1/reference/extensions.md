# Extensions

## Upstream model and client host

Upstream does **not** generate preference fields from a schema. Its extension
loader reads `manifest.json`, loads `js`/`css`, and lets extension JavaScript
render HTML templates, populate values, register handlers and save settings.
The upstream `extensions.js` template helpers and Caption/Memory settings
modules are the authorities for this model. The client follows that model,
not a new inferred-form protocol.

`client/` offers an explicitly loaded **Extension interface**, plus the existing
Advanced JSON editor. Selecting an extension does not execute scripts. The
interface runs in an opaque-origin `sandbox="allow-scripts"` iframe. The parent
owns authentication and forwards revision-checked patches to the selected
extension's settings endpoint, plus named World Info reads, World Info settings/catalog snapshots, installed extension identities, Persona catalog reads,
revision-checked Persona selection and read-only preset/regex snapshots. Reasoning parsing receives four scalar
settings switches through the parent.
Capabilities/tokens never enter the frame.

The host provides jQuery, Handlebars, DOMPurify, `SillyTavern.getContext[Async]`,
`extensionSettings` / `extension_settings`, setting save helpers, template
helpers, and local APP_READY / EXTENSION_SETTINGS_LOADED events. Both the context
and the limited `/script.js` / `/scripts/extensions.js` module shims expose these
helpers. Templates are sanitized before insertion. The extension owns all field
binding and layout. Its local modules are parsed and rewritten into a bounded
import-map snapshot; the backend never imports or executes those modules.

This is **not full browser-extension compatibility**. Missing modules/exports and
host APIs produce diagnostics. Cross-extension dependencies/templates, network,
remote resources, computed imports, browser storage, host chat/state,
generation and tools are not provided. Relative CSS/image/font resources are not
packaged; inline CSS and data/blob images work. `import.meta.url` is a blob URL,
not an asset server. HTML-only `ui` documents are sanitized and do not execute
inline scripts; interactive logic belongs in declared `js` modules. The minimal
host has `extensions_settings`, `extensions_settings2` and a per-extension
`<directory>_container` (non-word directory characters become `_`), not the full
upstream DOM or stylesheet. Arbitrary upstream extensions may need additional
adapters; inventory compatibility classifications are not a claim of UI parity.

Local `utils.js` helpers include filename sanitization with the upstream
`sanitize-filename` rules (including the 255-byte UTF-8 limit), character filename
extraction with an explicit `manualAvatarKey`, and a custom-list Font Awesome
picker. The picker accepts alias arrays, supports alias search and returns the
primary icon name, `''` for No Icon, or `null` on cancellation. Lists are limited
to 4096 icons, 32 aliases per icon and 128 characters per alias. Visible text
labels work without external fonts. Default icon discovery, character-catalog
lookup and downloads reject explicitly. No legacy sanitize-filename route or
additional parent operation is needed. `/script.js` exports upstream prompt
types/roles, system-message types, role lookup, parity/occurrence helpers and
memoized lazy fields. Avatar constants remain identifiers only; no upstream
image routes are served. These exports do not imply a native chat binding.

CSP blocks frame network/subresources. The client response CSP also constrains
frame navigation; preserve both policies when embedding the host elsewhere.
Only extension-scoped redacted settings, requested World Info books, registered
Persona IDs/names/current selection and the reasoning parsing switches enter the
frame. Settings containing
credentials cannot be replaced through this surface. Failed saves stop the save
queue and preserve a dirty/diagnostic state; reload is explicit, never a mutation
retry. Removing settings keys is unsupported by the shallow merge contract.

## Privileged package management

This explicit operator API is **not** part of the extension settings bridge. No
iframe, extension manifest or tool catalog grants management authority. All
requests retain normal authentication/CSRF requirements. Standalone requests with
user profiles require `profile.admin === true`; the companion's fresh capability
represents its operator. Set `enablePluginManagement: true` in operator config
(or `SILLYTAVERN_ENABLEPLUGINMANAGEMENT=true`) to enable writes. The default is
false. The legacy `enablePackageManagement` key (and its environment variable)
is used only when `enablePluginManagement` is absent. Restart the backend after
configuration changes and reconnect the client to refresh capabilities.
The standalone server and client development launcher read `<dataRoot>/config.yaml`
(default `data/config.yaml`), not the repository-root configuration.
`resources.packageManagement` is true only when that policy is enabled;
it is independent of `enableServerPlugins` and `enableHeadlessPlugins` execution
switches. No additional general-purpose filesystem, shell or network route exists.

### GET /api/v1/package-management

No-store inventory: `{ enabled, revision, packages, diagnostics? }`. Each package
has `{ kind, name, id, version?, repository?, commit?, manageable, diagnostic? }`.
`kind` is `extension` or `server-plugin`; `id` is `<kind>/<name>` and is not an
extension settings/UI ID. Version is optional manifest metadata. Revision hashes
the complete bounded filesystem snapshot, not only Git HEAD. Inventory remains
available when writes are disabled. It waits for an in-process management batch
to finish, so reload does not report an intermediate batch snapshot.

Extensions belong only to the authenticated user's `session.directories.extensions`.
Server plugins belong to the actual root supplied to the plugin loader. The
current standalone launcher delegates to companion startup, so both currently
use `dataRoot/plugins`; a non-companion loader may configure its standalone
`plugins` path. Management never touches `compat-source/upstream`, packaged
system/global extensions, or another user's extension root. Symlinked ancestor
roots are rejected. Symlink/legacy/unmanaged entries have `manageable:false` and
an explanatory diagnostic. Only packages installed through this API have managed
provenance and can be upgraded/removed here; adopt or repair legacy installs
through explicit operator filesystem tools, not an inferred trust grant.

### POST /api/v1/package-management/install

Body: `{ kind, url, name, expectedRevision, confirmTrust:true }`.
Names match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` (`node_modules` and `third-party`
are reserved). URLs must be HTTPS without credentials, query or fragment. No
redirects, interactive credential prompts, credential helpers, SSH/file/ext
transports, recursive submodules or Git LFS downloads are allowed.

### POST /api/v1/package-management/bulk

Body: `{ action:'upgrade'|'remove', packages:[{kind,name}], expectedRevision,
confirmTrust:true }`. Select **1–32 distinct packages**. Upgrade uses the managed
repository URL; it does not run the old checkout's Git config or reuse its remote,
branch hooks, filters, worktree or local modifications. An upgrade replaces local
file edits, so review the inspected inventory before confirming.

Both mutations return `{ results:[{kind,name,ok,message}], restartRequired }`.
A valid batch processes items sequentially and retains earlier successes when a
later item fails. Results stay in request order. Admission errors (disabled,
unauthorized, invalid body, stale revision, another management batch or an active
generation) fail the whole request before item processing. Concurrent mutations
are rejected, not queued. Git preparation has a 20-second per-item deadline and
a 90-second overall batch deadline; remaining items become explicit
`ok:false` / not-attempted results. Inventory reads wait for the current batch.
No automatic retries or provider/generation replays occur. On lost transport or
process interruption, explicitly reload inventory and inspect filesystem state
before deciding on another action. These mutations do not have caller-key
idempotency; do not replay a timed-out request.

Repositories are cloned shallow and bare into fresh hidden staging storage with
system/global Git configuration disabled. Only validated regular Git blobs are
materialized; symlinks, submodules, unsafe paths and reserved management metadata
are rejected. Hooks, clean/smudge filters, package lifecycle scripts, dependency
installation and package code never execute. The package must contain a JSON
`manifest.json` (extension) or `package.json` (server plugin). Bounds: 4096 tree
entries, 64 MiB filesystem snapshots/staging, 8 MiB Git output per command, 64 KiB
manifest metadata. Staging disk use is monitored every 25 ms and killed on excess
(a filesystem write can temporarily overshoot between checks); use an operator
filesystem quota for a hard kernel-enforced disk ceiling. Git subprocess groups
are terminated on timeout/limit failure on POSIX. No runtime package installation
is performed in companion mode or standalone mode. Dependencies must be provided
by a separately reviewed packaging workflow.

All package mutations fence new generation admissions process-wide and reject
currently active workers. File publication/removal uses same-filesystem rename;
upgrades retain the old directory until publication succeeds. Interrupted staging
is hidden from the plugin loader and may require operator inspection. The revision
is checked again after awaited Git preparation; external filesystem edits cause a
conflict rather than a silent overwrite. Cross-process/noncooperating filesystem
writers still require operator exclusion.

**Restart is mandatory.** There is no V1 enable/activation endpoint. After restart,
operators must separately review and explicitly activate a package using the
standard server-plugin switch or extension activation controls. The API never
calls runtime reload/import hooks. Existing
server-plugin code/routes already in memory stay loaded until restart, including
a removed plugin. New/changed extensions are persisted in the standard disabled
list without granting new regex scopes, settings namespaces or tool authority;
changed extension hooks/UI are also blocked in the current process regardless of
stale session settings. After restart, explicit extension activation remains a
separate decision. Existing isolated client frames are not remotely revoked by a
file operation; close them before management. Managed server plugins are excluded
from legacy automatic Git updating. Their execution after restart still requires
the independent server-plugin execution switch, and is trusted server code, not
sandboxed UI code.

Statuses: `200` inventory/results (including per-item failures), `400` malformed
input/trust missing, `403` disabled/non-admin, `409` stale revision/busy/generation
fence/restart-required UI, `413` bounded inventory exceeded, `422` unsafe storage.

## GET /api/v1/extensions

Lists installed extension manifests and runtime classification. Each row includes
`uiUrl`, `settingsNamespace` and `browserUiDeclared`. `resources.extensionUi`
advertises the JSON snapshot API, not full legacy extension compatibility.
`resources.extensionSettings` continues to gate writes via `headlessPlugins`.

## GET /api/v1/extensions/{extensionId}/ui

Authenticated, `Cache-Control: no-store`, JSON-only asset snapshot. Encode the
entire inventory ID as one path segment (`local/foo` → `local%2Ffoo`).

Response: `{ extensionId, name, namespace, base, entries, modules, templates,
css, html, libraries, activate }`. `base` and module keys are virtual identifiers,
not network URLs. `libraries` contains the packaged jQuery, Handlebars and
DOMPurify, lodash and Moment browser sources. The client creates blob modules inside its sandbox.

Uses manifest `js`/`css` (string or array), optional `activate` export, optional
`ui` HTML, and a non-headless `entry` fallback. Local static and literal dynamic
JS/MJS imports and reexports are included transitively. Rewriting preserves valid
string literals for single/double-quoted static imports/reexports and literal
dynamic imports (including non-interpolated template literals). Static imports
outside the extension must use implemented host modules. Unknown literal dynamic
host imports become local throwing modules: an unused conditional branch does not prevent startup,
and invoking it rejects with the exact missing module path without a network
request. Remote, computed and source/defer-phase imports fail before execution.
Third-party extensions use the upstream `/scripts/extensions/third-party/{name}/`
virtual directory depth, including for relative imports and full-path templates. Templates are discovered to depth 4; deeper subtrees are not traversed and do not reject otherwise usable extension UI. Limits: 4 MiB per UI
asset, 512 KiB per manifest, 128 loaded assets, 4 MiB extension source total,
512 entries per directory. Oversized asset errors identify the relative asset
path and its size limit; non-regular files are rejected separately.
Symlinked extension roots/assets and path traversal are rejected. No SPA/static
asset routes are introduced.

The separate client implements distinct virtual modules for `/script.js`,
`/lib.js`, `/lib/eventemitter.js`, and `/scripts/{extensions,st-context,events,
event-types,utils,templates,popup,i18n,power-user,PromptManager,sse-stream,
world-info,slash-commands,tokenizers,personas,reasoning,authors-note,constants,
RossAscends-mods,user,macros,openai,preset-manager}.js`, `/scripts/extensions/regex/engine.js`, plus the `SlashCommand`, `SlashCommandArgument`,
`SlashCommandEnumValue`, `SlashCommandCommonEnumsProvider` and `SlashCommandParser`
modules under `/scripts/slash-commands/`. The supported exports are
listed in `client/lib/extension-host.ts` and `client/lib/extension-runtime/`;
importing an unimplemented named export
fails visibly. The module registry is shared with backend snapshot validation.

`/script.js:printMessages` is also exposed as `getContext().printMessages`.
Opening an extension through the **Extensions** button inside a selected native
conversation binds this call to the parent-owned `chat.printMessages` operation. It
accepts `{}` alone: callers cannot submit a chat ID, path, method or transcript.
The parent reads the latest 100 stored rows through the existing authenticated
character/group paging resource, or its read-only render projection when enabled,
and acknowledges only after the exact React render commits and scrolls to the
last message. The function resolves to `undefined`; the bridge sends completion
alone, never transcript contents. No generation, message/metadata mutation,
native event replay or automatic retry is performed. Draft composer text remains
intact. Raw message editors must be finished first. A settings-only host, disposed
renderer, aborted/replaced extension session, superseding reload or overlapping
print request fails visibly; uncommitted renders have a 25-second timeout.
Native paging still exposes older messages. The upstream SPA message DOM,
configurable `chat_truncation`, media-load handlers and mutable chat globals are
not implemented by this adapter. This is a native rendering binding, not full
Tavern Helper or upstream frontend compatibility.

`/script.js` also exports async `saveChatConditional`, `saveMetadata` and
`saveChat`. Context aliases use the same functions, except that
`getContext().saveChat` points to `saveChatConditional`, matching upstream's
conditional character/group dispatcher rather than its raw character-only save.
These are guarded entry points, not implemented transcript persistence: every
call rejects because the complete mutable upstream chat state and its save
lifecycle are not bound. `saveMetadata` delegates to `saveChatConditional` as in
upstream. Importing these functions or creating a debounced callback is safe;
calling them never reports a successful save, reads supplied snapshot/options,
falls back to settings persistence, redraws the view or sends a backend request.
The native paged transcript must not be used as a replacement full-chat snapshot.
The existing synchronous `saveMetadataDebounced` restriction remains in place.

The script module also links the native-operation entry points required by
Tavern Helper without granting their unavailable lifecycles. Synchronous guards
cover `saveCharacterDebounced`, `getThumbnailUrl`, `getCharacterCardFields`,
`messageFormatting`, `addOneMessage`,
`reloadMarkdownProcessor`, `showSwipeButtons`, `setGenerationProgress`,
`setUserName` and `scrollChatToBottom`. Async guards cover `clearChat`,
`reloadCurrentChat`, `deleteCharacter`, `getCharacters`, `getOneCharacter`,
`getPastCharacterChats`, `printCharacters` and `selectCharacterById`. Calls fail
before inspecting options, scheduling a debounce, reading a native catalog or
issuing requests. In particular, `saveCharacterDebounced` requires the upstream
character edit form/draft and a revision/digest-checked save lifecycle; it must
not trigger an unrelated native Save button or settings write. Existing native
redraw/send-lock adapters remain separate. Native chat/card snapshots retain
their documented read-only semantics. Temporary prompt injection uses the
scoped registry and explicit submission capture described below.

`substituteParams` and deprecated `substituteParamsExtended` support a local
literal-only projection. Falsey input returns `''`; other non-strings are
converted with `String`, and literal whitespace/HTML remains unchanged. Modern,
extended and legacy positional call shapes accept literal content without
evaluating native context, option getters, additional macros or post-processing
callbacks. Curly macro openings and legacy angle-bracket user/character/group
aliases reject, even with explicit name overrides. This is not a macro engine
and does not evaluate greetings, variables or native selection.

`extractMessageBias` uses a fresh isolated Handlebars instance per invocation,
matching upstream's `bias` helper: matches join with spaces and a leading space;
empty/missing helper arguments and template failures retain source behavior.
`getBiasStrings` implements the source `continue`/`impersonate` suppression
branch only. Other types require unavailable chat history, configured prompt
bias and native macros and reject without exposing settings text.
`DEFAULT_SAVE_EDIT_TIMEOUT` (1000 ms) and `DEFAULT_PRINT_TIMEOUT` (100 ms) retain
source constants. `unshallowCharacter(undefined)` resolves without catalog
access, as upstream. Explicit IDs resolve for the fully loaded native snapshot
and unknown indices; they reject before the catalog is initialized.

`stopGeneration` implements only upstream's no-active-processor/controller
branch: it emits `GENERATION_STOPPED` on the frame-local event emitter and
returns `false`. It never sends native cancellation, clears UI locks,
acknowledges a journal outcome or fabricates a successful stop. Async listeners
follow the existing frame emitter ordering/error diagnostics. The corresponding
context function is the same reference. Native provider work remains available
only through the client's separate explicit generation/cancellation flow.

`/script.js:deactivateSendButtons` and `activateSendButtons` have matching
`getContext()` aliases. In a conversation-bound host, they return promises that
resolve to `undefined` after a parent-owned `chat.setSendButtonsEnabled`
operation. The only accepted payload is `{enabled:boolean}`; no chat ID, path,
generation ID or transcript crosses the bridge. Deactivation disables the native
Generate button and reply-alternative selectors. Activation releases only that
extension session's UI lock; native busy, active-generation and unresolved
admission fences still apply. Repeated deactivation is idempotent. Reloading or
closing the frame, stopping its session or changing conversations releases its
lock automatically. Settings-only hosts and stale/aborted sessions reject.
These are asynchronous native UI adapters, whereas upstream updates its SPA
synchronously. They do not implement upstream stop-button events, swipe DOM
visibility or `body.dataset.generating`, grant generation
authority, cancel work, acknowledge outcomes or persist anything.

`/script.js:cleanUpMessage` supports object and legacy positional arguments for
the isolated Chat Completion settings-frame path. Callers must pass an explicit
`stoppingStrings` array; both complete and partial suffixes follow source order.
The function then applies the detached authorized regex rules and source newline,
invisible-whitespace, end-marker, Markdown, sentence and space cleanup. It rejects
unbound character/group/chat state, other APIs, default generation stopping state,
required name stripping and prompt-bias macro expansion. Name-display switches
must permit the requested path; setting `trimNames:false` alone does not disable
the upstream unconditional character-name stripping. Missing configuration is
reported when queried. No prompt-reasoning instance can be admitted in this
settings frame, so space trimming uses the upstream no-instance branch.

`/script.js:baseChatReplace` preprocesses literal card text with the source order:
optional newline collapse followed by carriage-return removal, without trimming
or applying message-output regex. Empty strings and non-string values pass
through unchanged. Curly macros and legacy `<USER>`, `<BOT>`, `<CHAR>`,
`<CHARIFNOTGROUP>` and `<GROUP>` aliases reject because the native macro context
is not bound; name overrides do not bypass that check.
`/script.js:parseMesExamples` preserves the source case-sensitive initial
`<START>` check, case-insensitive block splitting, empty blocks and trailing
newlines. It uses `<START>\n` headings for OpenAI or an explicit Instruct argument,
and the captured context example separator otherwise. Parsing leaves macros in
example bodies untouched. A separator requiring macro substitution rejects even
when its heading would be ignored, matching the source dependency order. Missing
settings and changed API snapshots also reject. These local formatting helpers
do not enable text-completion dispatch or Instruct generation.

The parent-only `script.cleanupSettings` read uses the existing `/settings` GET.
It memoizes success/failure, rechecks abort/session identity after awaits and
projects only the API kind, six boolean cleanup switches, prompt-bias presence
and the optional context example separator. The native bias and separator must
each be strings of at most 64 KiB UTF-8; the bias text, context story template and
surrounding settings never enter the frame. `/script.js` imports initialize this snapshot
and the regex adapter within the four-operation startup batches. Pure
`power-user.js:collapseNewlines`, `power-user.js:fixMarkdown` (including display
mode) and `utils.js:trimToEndSentence` are separately available without native
state. These helpers do not change backend output processing, grant native
generation access or establish full Tavern Helper compatibility.

Supported behavior includes scoped settings saves, extension-owned Handlebars
templates, jQuery ready initialization, upstream event names and listener order,
once/removal, late APP_READY/APP_INITIALIZED listeners, common pure utilities,
locale translation additions, local image inspection/conversion, condition
waiting, and TEXT/CONFIRM/INPUT/DISPLAY dialogs within the frame. Dialogs support
custom buttons (including action-only buttons), checkbox/text/textarea/number
inputs, input result maps, close vetoes and lifecycle callbacks. `Popup.show.input`
normalizes cancellation to null. CROP, upstream popup styling/animation, full
keyboard/focus behavior and forced close of blocking dialogs remain unsupported.

`Prompt` and `PromptCollection` retain upstream defaults, instance checks,
identifier lookup and positional overrides. Slash command descriptors, argument
normalization, enum values and per-frame command/alias registration are available;
they do not execute STscript or register commands in the conversation UI. Pure
boolean/type/role enum providers work. Providers requiring host state reject on
invocation instead of inventing empty catalogs. Slash help rendering is not yet
implemented. The SSE module decodes UTF-8 byte streams into completed
`MessageEvent`s with multiline data and sticky IDs; unfinished EOF events are
discarded. Smooth-streaming animation/settings are not exposed.

The tokenizer adapter exports `guesstimate`, `getTokenCount` and
`getTokenCountAsync`. Counts are local estimates: `Math.ceil(text.length / 3.35)`
using JavaScript UTF-16 string length, deliberately not upstream's UTF-8 byte
length. Empty/non-string inputs return zero; the count helpers add optional finite
numeric padding to nonempty strings (default zero). The async helper returns a
Promise of the same count. `CHARACTERS_PER_TOKEN_RATIO` and the legacy
`BYTES_PER_TOKEN` alias are both 3.35. Both count helpers are also available from
`SillyTavern.getContext()`. This does not implement model-specific tokenization,
token ID encoding/decoding, remote services or provider usage accounting. These
estimates do not change backend prompt assembly or its capability flags.

`loadWorldInfo(name)` returns the native book from the existing authenticated
`GET /api/v1/world-info/{name}` through a parent-only operation allowlist. Every
call reads the server; there is no shared mutable cache. Unlike upstream's null
fallback, failed reads reject visibly. Only the book is returned, without its
management revision. The bridge accepts no URLs, paths, methods or headers, limits
operations to four concurrent requests per frame, bounds returned books to 4 MiB,
aborts reads when the host unmounts and discards replies from replaced sessions.
World Info constants and delimited-regex parsing are also available. Book
mutation and scanning remain unsupported.
Loading an extension interface explicitly grants the resource access described
in the client UI; it does not grant arbitrary API access.

`world-info.js` initializes `world_names`, `selected_world_info`, `world_info`,
the supported scalar setting exports and `getWorldInfoSettings()` from a bounded
read snapshot of `/world-info` and `/world-info-settings`. It projects only the
global selection, character names/extra-book bindings, and the ten native scan
switches/ranges. Absent supported fields use upstream defaults (including scan
depth 2 and include-names true). Budget, budget-cap and overflow-alert fields are
absent from the settings result because V1 intentionally does not expose them;
no budgeted scanning is implied. Opaque settings/binding fields are excluded.
Returned objects and arrays are detached; changes require reloading the frame.

The parent bounds the settings document to 1 MiB, catalog to 128 KiB/512 books,
selection/character/extra-book lists to 512 entries, and checks catalog metadata
and the settings revision again before publication. Unreadable catalog entries,
missing bound/selected books, malformed data or observed drift fail initialization.
Legacy string/list selections are projected without rewriting native settings.
Success and failure are cached per frame, with abort/session checks around reads
and cached replies. This verifies read snapshots; it is not a cross-resource
transaction and does not preload or validate every book's JSON contents.

The source `newWorldInfoEntryDefinition` (42 fields),
`newWorldInfoEntryTemplate` (39 fields) and `convertCharacterBook()` are local
data helpers. Conversion preserves source mappings, opaque extension data,
original-data references and assignment of missing entry IDs on the caller's
object. IDs such as `__proto__` become ordinary own entries without invoking a
prototype setter. Conversion never imports a book, grants regex authority or
modifies a character. Book save/create/delete, prompt scanning, list reload,
native setting writes and upstream editor/button operations explicitly reject
before dispatch; they need their native revision/reference/execution lifecycle.

`extensions.js` initializes detached `extensionNames`/`extensionTypes` from the
installed V1 inventory. Only names/types cross the bridge (at most 512 rows and
1 MiB before projection). System IDs remain unprefixed; local/global IDs become
`third-party/{name}`, with local installations winning name conflicts as upstream
does. This inventory does not indicate that other extensions were executed or
grant access to their settings/templates. Reads are cached until frame reload,
including failures, and reject stale/aborted sessions. `saveMetadataDebounced`
is importable but rejects immediately because no chat metadata lifecycle is bound.

The Persona module initializes from `GET /api/v1/personas` before importing the
extension. `getUserAvatars(false)` reads registered Persona IDs, not upstream's
complete directory of avatar image files. `user_avatar` is a live module export;
the `/script.js` re-export and `getContext().userAvatar` follow the same selected
ID before `PERSONA_CHANGED` listeners run. `setUserAvatar(id)` uses
the existing Persona selection endpoint with the inspected revision retained in
the parent. It updates the live binding and emits frame-local `PERSONA_CHANGED`
only after success; selecting the current ID is a no-op. Concurrent reads and
selections cannot overlap a selection. Failed/uncertain selection stops further
selections until explicit reload; it is never retried automatically. Read-only
hosts reject selection. Catalogs are limited to 128 entries and 1 MiB of projected
IDs/names. Selection persists native Persona settings but does not rerender the
upstream UI or retrigger chat greetings. `getUserAvatars(true)`,
`navigateToCurrent:true` and `getUserAvatar` media URLs remain unsupported.

`/script.js` and context expose `name1` as the same live current display name.
It comes from `username` in the revision-bound Persona response, independently
of the selected descriptor name, avatar filename and authenticated account.
The parent forwards only this scalar plus the existing catalog projection,
rejecting missing/non-string names or names over 65536 UTF-16 code units.
Successful reads/selections publish the name before `PERSONA_CHANGED` listeners;
failed, invalid, aborted or replaced replies do not update it. No new requests
or selection retries are added. `name2` and context's alias read the frozen
selected card's name, the source idle group name (`''`) or initial no-selection
system name (`SillyTavern System`). No active native group-generation speaker is
mirrored, and card names change only after reloading the extension. Neither name
export permits renaming native users/cards or changing transcript rows.
`/script.js:is_send_press` is a live, read-only projection of the selected native
character conversation's generation submission and observed worker activity.
The initial value is supplied before extension modules execute; parent updates
refresh the ESM binding without reloading the frame. `/script.js:isGenerating()`
and context's same function also include observed group-batch activity. Group
member phases are not exposed: group batches do not synthesize a per-member
`is_send_press` value. Settings-only hosts without a conversation begin idle.
This is scoped to the host's selected conversation and existing native
observations, not a process-wide or cross-tab activity query.

Submitting a generation sets activity; accepted/nonterminal records retain it.
A terminal record whose worker has not drained remains active. Once drained,
unknown/cancelled outcomes that still require acknowledgement are inactive;
the native recovery fence remains enforced independently. Newer sequence
observations override stale history for the same request. A failed observation
does not manufacture completion or replay a request. Native preview, settings
writes and send-button locks do not establish generation activity. No generation
IDs, prompt contents, tool arguments or credentials enter this projection.
Updates emit no synthetic generation-started/stopped/ended events, and grant no
execution or cancellation authority. Aborted/replaced frames receive no further
updates. `setSendButtonState` remains unbound.

`extension_prompts` is the current isolated extension frame's mutable temporary
prompt registry, also exposed as context `extensionPrompts`. It is not a snapshot
of server-owned Author's Note, Persona or World Info injections, nor a shared
registry across extension frames. `setExtensionPrompt(key, value, position,
depth, scan=false, role=SYSTEM, filter=null)` uses source scalar coercions and
stores `{value,position,depth,scan,role,filter}`. Direct entry/value changes and
deletion (including Lodash `unset`) are supported. Conversation hosts advertise
`resources.clientExtensionPrompts`; settings-only hosts can read an empty
registry but reject writes. Closing/reloading an interface discards its registry.

On an explicit native Preview or Generate action, the parent captures registered
frames before sending any API request or saving a generation caller ID. Data is
snapshotted before awaiting predicates; synchronous/asynchronous `filter`
functions execute once per capture in sorted key order, stay inside the frame,
and omit entries returning false. Exceptions, a 10-second capture timeout,
invalid data, concurrent capture, duplicate keys across sources or source/session
replacement abort submission without replay. Capture is not a generation event:
no synthetic `GENERATION_ENDED`/`GENERATION_STOPPED` is emitted, so extensions
needing one-shot injection cleanup must explicitly remove their entries until
full generation event integration exists. Opening an interface does not dispatch.

The named parent-to-frame capture transfers only resolved prompt data. The
parent validates it and includes `extensionPrompts` in the ordinary user-initiated
V1 preview/generation request. Both sides bound the map to 128 keys, 128-character
keys, 65536-character values and 1 MiB JSON; positions are -1/0/1/2, depths
0..10000 and roles 0/1/2. Control-character and prototype keys, descriptors,
invalid enums and executable transport fields are rejected. The V1 boundary
validates independently, includes the captured data in caller-key identity and
passes it into the existing bounded macro/World Info/source prompt worker.
`scan:true` participates in WI scanning; placement, role and depth use source
packing. Native preparation may replace its own reserved injection keys.
Preview persists no effects. Admitted generation retains normal macro/WI effect,
cancellation, tool-followup and transcript boundaries; request injections do not
persist as settings or transcript rows. `features.extensionPrompts` remains false:
this scoped client input does not establish full extension lifecycle compatibility.

`online_status` is a live `/script.js` export; context exposes the same value as
`onlineStatus`. Script initialization requests the named, exact-empty-argument
`provider.status` observation, which only reads `/api/v1/provider-status` and
forwards one validated `Valid`/`no_connection` scalar. No provider URL, credential,
status identity, model rows or surrounding response crosses into the frame.
The frame has no operation for `/provider-status/check`; provider checks are an
explicit API-settings action. Initial/pending/failed/expired/invalidated states
all project to `no_connection`, and only a successful current-connection catalog
check establishes `Valid`. Configured credentials, model discovery and generation
success cannot establish this status. A catalog check is not a model-generation
test and unsupported provider formats remain unsupported.

After frame readiness, the parent polls local backend observations sequentially
every five seconds. It never invokes a remote check. Backend read failures clear
previous success. The frame accepts updates only from its parent with the current
session channel, updates ESM bindings/context before source-style frame-local
`ONLINE_STATUS_CHANGED` notifications, and emits only on value changes. Initial
snapshot publication emits no changed event. Abort/reload/unmount/connection or
selection replacement clear timers and discard delayed replies. No native
generation state, send locks or authorization flags are changed by these events.

`reasoning.js` provides source-derived `extractReasoningFromData`, including
explicit API/source overrides and the upstream thoughts visibility switch. Its
initial settings snapshot contains only API kind, source kind, thoughts visibility
and text-generation type; reload refreshes it. Provider URLs, credentials, headers
and other settings never enter the frame. Parsing response shapes for other
providers does not enable their dispatch or change backend capability flags.
Identifier strings are bounded to 256 characters; malformed snapshots reject.
`/script.js` exports the same captured API kind as `main_api`, also accessible
through `getContext().mainApi`. Importing `/script.js`, `st-context.js` or
`extensions.js` initializes the Persona/reasoning/OpenAI dependencies before loading
extensions, with each initializer scheduled once even when its module is also
imported directly. Persona, settings and identity operations recheck abort/session
identity after awaiting API responses; stale replies cannot publish state or
advance the retained Persona revision. A selection with a stale response stops
further selection until reload, since its persistence outcome may be uncertain.

`/script.js` and context imports load a real, detached character catalog through
the parent-only `characters.snapshot` operation with exactly `{}` arguments.
The parent reads `/characters`, then each listed `/characters/:id`, and rechecks
the directory's ordered identity/name/revision list. Limits are 512 cards, 1 MiB
catalog, 4 MiB per card response and 16 MiB aggregate card responses. Missing
revisions, mismatches, failed reads and changed catalogs fail the entire load;
there is no partial publication or automatic retry. Native card content/opaque
fields survive projection; transport envelopes and fabricated statistics do not.

`characters` and `getContext().characters` share this deeply frozen snapshot.
`this_chid` and context `characterId` identify the selected array index, not the
native slug. A conversation-bound host captures selection from its parent,
overriding only the selected character's `chat` with the open conversation ID.
Group hosts expose context `groupId` without selecting a character. The frame
cannot supply another target. Settings hosts have no selection; their directory
is still real (and empty only when the native catalog is empty).

`getCurrentChatId()` and context `chatId` return the captured conversation ID,
or `undefined` without a selection. Navigation, close, reload and unmount abort
the old session, including pending startup reads. Snapshots remain fixed until
reload; this is read compatibility, not a mutable upstream character editor or
transcript. `unshallowCharacter(undefined)`, loaded cards and unknown indices
preserve upstream no-fetch returns; explicit IDs before initialization reject.
Catalog refresh/navigation/edit functions and transcript saves remain guarded.

`chat` and `chat_metadata` from `/script.js` are the same deeply frozen objects
as context `chat` and `chatMetadata`. Startup reads a complete native snapshot
through the parent-only `chat.snapshot` operation, accepting exactly `{}`. The
parent captures the conversation selection and chooses the character or group
snapshot GET; callers cannot supply IDs, URLs or methods. Raw messages and
metadata come from the same strict UTF-8/JSONL file read, bounded to 8 MiB and
10000 messages. No corrupted row is skipped, no page masquerades as full history,
and failed, oversized or stale-session reads do not publish a fallback state.
The response must carry the exact selected identity, a SHA-256 revision and an
explicit header-presence flag; the parent also caps its JSON envelope to
8 MiB + 4096 bytes. Neither the digest nor a successful read authorizes writing.

The metadata header is excluded from the upstream message array. Its positions
are zero-based upstream chat indexes; no native paging `index` is injected.
Stored reasoning, swipes, message text, variables and opaque metadata survive
unchanged. Legacy headerless group files supply empty metadata in memory only.
A settings-only host has the source initial empty chat/metadata state with no
native chat read; this state is never substituted for a failed selected chat.
Snapshots remain fixed until extension reload, including after `printMessages`
redraws the native page. Transcript/metadata mutation remains unavailable;
attempting to modify the frozen objects fails, and save entry points still
reject. Native scoped regex/cleanup evaluation also remains guarded in a bound
conversation even though its raw transcript is readable.

`authors-note.js` exports upstream `NOTE_MODULE_NAME`, `metadata_keys` and the
frame-local no-injection state `shouldWIAddPrompt:false`; this is not a read of
native World Info evaluation. In settings-only frames `setFloatingPrompt()`
follows upstream's no-chat early return. Conversation-bound calls reject until
injection is integrated. It does not run chat injection or author-note editing;
`initAuthorsNote()` rejects because the upstream UI is absent. No chat metadata
or prompt snapshot is fabricated.

`constants.js` supplies upstream debounce timings, generation trigger names,
injection IDs/helpers, media/swipe constants and `Symbol.for('ignore')` identity.
These values do not authorize the associated features. `power-user.js` and
`personas.js` share the same Persona position enum object. Power-user defaults,
chat styles and enter-key options are available as constants, while access to
live `power_user` state and generation stopping strings rejects explicitly.

The bundled Bowser browser detector is exposed as `Bowser` from `/lib.js`.
`RossAscends-mods.js` uses it for upstream mobile/tablet classification with
per-frame parsing cache. Generation duration, local filename date formatting
and ISO message timestamp helpers are also available. It does not install
upstream observers/hotkeys or restore the SPA; `favsToHotswap()` rejects because
character navigation is not bound to this frame.

`user.js` initializes before extension imports from a parent-projected authenticated
`GET /api/v1/session` snapshot containing only handle, account mode and profile
admin status. It exports `accountsEnabled`, `isAdmin()` and
`getCurrentUserHandle()`. Upstream single-user behavior is preserved: `isAdmin()`
returns true with accounts disabled and the handle helper returns `default-user`;
with accounts enabled they use the authenticated profile. This is informational
and never authorizes backend operations. Missing or malformed session fields fail
initialization instead of guessing privileges. The snapshot is scoped to the
loaded frame; reload after changing account identity or mode. `currentUser` and
account-management UI are not implemented; `setUserControls()` rejects rather
than changing server-owned mode. No legacy user-management route is exposed.

`macros.js` exposes the legacy `MacrosParser` custom registry inside each frame:
register/unregister/get/has, iteration, `populateEnv()` and
`sanitizeMacroValue()`. Names, insertion order, retained descriptions on override,
callback identity and value conversion follow the upstream legacy registry.
Registration/population does not execute callbacks. This registry is local to the
frame and does not install macros into the backend worker or enable the upstream
experimental registry. `getLastMessageId()` searches the complete snapshot with
upstream zero-based indexes, preserving `exclude_swipe_in_propress` (including
the source spelling), unfinished-swipe skipping and caller-provided filters.
No selection/no matching message returns `null`; filter errors propagate.
Importing `macros.js` initializes the snapshot dependencies before evaluation.
`evaluateMacros()` and
`initMacros()` reject because the upstream evaluation context and builtin engine
are not bound. Registering a macro does not make it available to native prompt
preparation or generation.

`openai.js` provides the upstream text `Message`, `MessageCollection`,
`ChatCompletion`, `TokenHandler` and `IdentifierNotFoundError` interfaces. Local
collection identity, order, shallow chat projection, explicit flattening, tool
metadata reconstruction, system-message squashing and budget bookkeeping follow
upstream behavior. Default message counts approximate the UTF-16 length of the
serialized message object (`ceil(JSON.stringify(message).length / 3.35)`), using
the same local estimator as `tokenizers.js`. These counts are not model tokens or
provider usage, and do not change native prompt packing or generation. Custom
`TokenHandler` instances use the caller's supplied async counter.

`getChatCompletionModel()` uses explicit settings or a parent-projected read-only
initialization snapshot containing only source, model IDs, the thoughts switch
and configured `openai_max_context`/`openai_max_tokens` limits.
Only those fields are readable through `oai_settings`; unknown fields and all
mutations reject. Connection URLs, headers, credentials, prompts, extension state
and proxy presets are excluded. Reload the frame to pick up settings changes.
The parent requires safe integers for configured limits (context at least 1,
response at least 0); missing fields remain absent, and malformed limits reject.
`/script.js` supplies `getMaxContextTokens()` and `getMaxResponseTokens()` from
the same settings, plus `getMaxPromptTokens(overrideResponseLength)` and its
deprecated alias `getMaxContextSize` (the same function). The latter returns
context minus the reserved response length, rather than the entire context
window. Invalid/nonpositive overrides use the configured response limit;
positive fractional overrides and Infinity preserve upstream arithmetic, with
no clamping when the result is negative. A positive override does not require a
configured response limit. These helpers support the Chat Completion API only;
unbound API kinds and missing required limits reject explicitly. They query
settings, perform no tokenization and do not modify native prompt packing,
generation admission, provider limits or reported usage.

`getStreamingReply()` parses upstream provider response shapes, reasoning
precedence, inline data URLs and thought/tool signatures into caller-owned state.
This is data parsing only: it performs no fetch, media processing, tool execution,
provider dispatch or lifecycle completion check. It is not an authorization or
proof that a streamed generation completed. Source/post-processing/reasoning/
endpoint constants and prompt position/role helpers are also available.

Generation, native prompt preparation, upstream chat/example setters, prompt
manager initialization/UI, proxy reads, provider settings writes and the upstream
streaming-error UI explicitly reject. The exported `promptManager` is only a
rejecting facade, not a usable Prompt Manager instance. Image/video/audio support
checks return false; `Message` media mutation/processing methods reject before
changing content. These interfaces do not establish provider or media support.

`preset-manager.js` initializes read-only managers for `openai`, `context`,
`instruct` and `sysprompt` from existing V1 preset/catalog/active-settings GETs.
`getPresetManager()` defaults to the captured main API; unsupported APIs (including
text completion and reasoning templates) return `null`. It exposes
`getAllPresets()`, `findPreset()`, selected name/value queries, `getPresetList()`,
`getCompletionPresetByName()`, `readPresetExtensionField()` and API classification.
OpenAI option values are snapshot-local string indices, with a name-to-number
`preset_names` map; advanced-formatting values/names are keyed strings. They are
not native API identifiers. The selected name comes from V1 active metadata;
if that name is absent from the catalog, its selected value is `undefined`.
Active Chat Completion fields use the shared native alias table (for example,
portable `temperature` becomes `settings.temp_openai`). Extension-field reads for
the selected preset use active settings, not its saved file. Returned lists and
objects are detached copies; changing them never alters the cached snapshot or
native state. Reload the frame to observe later native changes.

The parent restricts the snapshot to four preset kinds, 128 names per kind,
256 total files, 1 MiB per active/file document, 8 MiB aggregate document data,
64 nesting levels and 200000 projected nodes. It uses at most four concurrent
GETs, checks file/active revisions, and rechecks catalogs/main API before
publication. Unreadable catalog entries, drift or invalid/oversized data fail
initialization; partial snapshots are never published and failed initialization
is not silently retried. This is a verified read snapshot, not a transactional
lock across all native preset kinds. The host also batches adapter initialization
within the parent's four-operation resource limit.

Credential fields, provider URLs/headers/body overrides, proxy configuration and
prototype-related keys are recursively excluded; response envelopes, revisions
and connection-change metadata stay in the parent. This is a sanitized subset of
upstream preset content. Selection/save/rename/delete/extension-field writes,
default restoration, live settings serialization, list mutation and selector DOM
access explicitly reject. They require a separate native revision/confirmation
lifecycle. No preset writes, connection consent, mode changes or full preset
compatibility are granted by these read interfaces.

`extensions/regex/engine.js` provides upstream script/placement/substitution
constants, `RegexProvider` with independent 1000-entry LRU caches, and local
`runRegexScript`/`getRegexedString` text processing. Captures, named captures,
`{{match}}`, trim strings, placement, depth, edit and Markdown/prompt filtering
follow the source implementation. `utils.regexFromString` preserves upstream
pattern/flag parsing. These are iframe-local computations, separate from the
backend's bounded regex worker; they never process or persist native chat rows.

Before extension imports, a named parent operation reads `/regex-settings`, the
main API, and the supported API's active preset. Only known executable script
fields, enabled state, scope lists and active API/name enter the frame; opaque
script fields and unrelated settings/connection data are omitted. Documents are
bounded to 1 MiB, script/scope-name lists to 512 entries and preset scope maps to
32 APIs. Revision/main-API checks before publication reject drift; replies and
in-flight reads check session ownership/abort. One snapshot (including failures)
is cached per frame until reload. This is a verified read snapshot, not a
transactional lock with other adapter snapshots.

`getRegexScripts`/`getScriptsByType` return detached global then preset rules;
`allowedOnly` honors captured preset grants. `getCurrentPresetAPI` and
`getCurrentPresetName` describe that snapshot. `isScopedScriptsAllowed` and
`isPresetScriptsAllowed` only inspect grants. The settings frame has no selected
character, so character script lists are empty; borrowing a character/chat
context explicitly rejects. The global enabled switch is respected without
hiding scripts from catalog reads. Missing `trimStrings` defaults to an empty
array, as in native rule normalization.

Replacement/trim strings that need macro expansion, and RAW/ESCAPED find patterns
containing macro syntax, reject when reached: no native macro context is bound.
`{{match}}` remains supported. Script saves and all scope allow/disallow methods
reject before dispatch. Reads never grant scopes, alter regex enablement, install
native rules, write chats or claim full scoped-regex/extension compatibility.

Host-owned templates, chat state, generation, slash execution, model tokenizer services,
and preset writes remain unimplemented. The event bus is local to this frame; it does not synthesize chat
or generation events. `writeExtensionField` and `writeExtensionFieldBulk` mean
character-card mutation upstream and explicitly fail here; they never write an
extension settings field under those names. Unsupported APIs do not report a
successful no-op. No backend capability or credential is exposed to the frame.

- `200`: UI snapshot.
- `404`: Extension/asset missing or symlinked.
- `413`: Asset/directory bounds exceeded.
- `422`: No UI or unsupported import requirement.

## GET /api/v1/extensions/{extensionId}/settings

Reads an installed extension's namespace, with credential redaction:
`{ extensionId, namespace, revision, settings }`.

The default namespace is the extension directory basename, not its inventory ID.
A manifest can explicitly declare `settings_namespace` when its upstream setting
key differs. It must be a safe, non-reserved identifier. Thus `local/foo` edits
`extension_settings.foo`, never a literal `extension_settings['local/foo']`.
Unknown extensions cannot read arbitrary settings namespaces.

## PATCH /api/v1/extensions/{extensionId}/settings

Requires `headlessPlugins`. Body is a JSON object shallow-merged into this
namespace; other extension/provider settings are preserved. Optional `If-Match`
contains the exact opaque `revision` from GET (without added quote characters).
The isolated host always sends it. Legacy Advanced JSON remains unversioned and
warns accordingly. There is no automatic retry on conflict/failure.

Credentials, reserved fields, and replacement of containers with stored
credentials are rejected. Non-object namespaces use their dedicated management
APIs. Settings/patches are bounded to 1 MiB.

- `200`: Updated settings envelope.
- `400`: Invalid or credential-bearing patch.
- `403`: Headless plugins disabled.
- `409`: Revision conflict; explicitly reload.
- `413`: Result exceeds the size limit.
- `422`: Non-object settings namespace.

## GET /api/v1/extensions/{extensionId}/shell

`410`: The previous same-origin executable shell is retired. Use `/ui` and the
isolated client host. V1 is not finalized; there is no implicit fallback to an
unsafe same-origin execution path.
