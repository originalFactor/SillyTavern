# V1-only client

This separate Next.js client uses the existing `/api/v1` backend contract. It
does not restore or serve the upstream SPA. Upstream files in
`compat-source/upstream/` are behavior references, not runtime imports.

Install and run with pnpm:

```sh
pnpm --dir client install
pnpm --dir client dev
```

`dev` starts the backend watcher, receives its loopback capability and starts
Next on loopback. `/api/v1/client-connection` is a **Next host bootstrap route**,
not a new SillyTavern backend endpoint. It exposes only that host's managed
companion handshake with `no-store`. A separately hosted client can connect
manually to a bearer companion; the capability remains in memory and must be
reentered after a full reload. Cookie sessions requiring a legacy CSRF bootstrap
are explicitly rejected. Only the server origin and UI language preference are
remembered (alongside the generation recovery IDs described below).

## Interface languages

The workspace supports **English (en-US)** and **简体中文 (zh-CN)**. Use the language
selector in the top bar or the initial connection dialog. The first server render
negotiates `Accept-Language` (English fallback); an explicit choice is remembered
in `st-v1-locale` localStorage and a same-site cookie, so reloads render the selected
language immediately. If browser storage is blocked, switching still works for
the current session. The document's `lang` attribute follows the selected locale.

Switching languages does not navigate, reconnect, refetch resources, clear drafts,
change protocol values, or replay generations. Character names, prompt content,
raw JSON keys/values and backend diagnostic payloads are not translated. Native
macro facts continue to use the browser's locale independently of UI preference.

UI messages live in `lib/locales/{workspace,settings,conversation}.ts`. English
source messages are stable catalog keys; each entry supplies its Chinese value.
`lib/i18n-core.ts` derives the matching en-US catalog and handles `{name}`
interpolation/fallback. Components use `useI18n()` from `lib/i18n.tsx`. Keep translated
labels separate from option values and avoid adding locale dependencies to
network/lifecycle effects.

## Implemented frontend surfaces

Navigation uses explicitly advertised `/capabilities` resource flags. Complete
group, scoped-regex, preset/Instruct and tool compatibility flags remain false
where reported by the backend; individual supported resources are presented as
a subset.

| Surface | Available operations | Upstream reference |
| --- | --- | --- |
| Character cards | Inspect, create/edit, delete with a separate associated-chat option, JSON/PNG/APNG/CHARX import, JSON/PNG/CHARX export, revision-checked avatar replacement | `script.js`, `scripts/char-data.js` |
| Personas | Create/edit descriptor, title, description, placement/depth/role/lorebook, select, delete | `scripts/personas.js` |
| Prompt Manager | Enable, reorder, add/remove prompts, roles, content, depth/priority; advanced JSON retains triggers and all opaque properties | `scripts/PromptManager.js` |
| Presets | Four preset types, import/edit/copy active settings/save-as, export/delete, separate revision-checked activation and connection consent | `scripts/preset-manager.js`, `scripts/openai.js` |
| World Info | Native book CRUD/import/export, entry editing, advanced entry properties, independent scan/global/extra-character bindings, chat binding and Persona lorebook | `scripts/world-info.js`, `scripts/personas.js` |
| Macro variables | Separate global variables/engine and chat-local JSON documents; explicit reload on conflict; reads/saves do not execute macros | `scripts/variables.js`, macro engine modules |
| Regex | Global scripts/settings and explicit character/preset scope authorization; importing never confirms grants | `scripts/extensions/regex/engine.js`, `index.js` |
| Chats | Create with server greeting, bounded older/newer/latest pages, raw/display toggle, raw message editing/deletion/swipe selection; character rename/delete | `script.js`, `scripts/chats.js` |
| Groups | Descriptor CRUD/member selection, attached chats/create/delete, raw/display pages, edits/deletes/swipes, per-chat sampling, member-specific preview and advertised generation kinds | `scripts/group-chats.js` |
| Generation | Read-only previews, normal/regenerate/continue/quiet where advertised, periodic snapshot observation, cancellation, backend usage, scoped history, caller-key recovery/abandonment and exact-sequence acknowledgement | `script.js`, `scripts/openai.js` |
| Provider | Settings, write-only key presence/write/delete, model IDs through V1 only; no external metadata catalog or direct provider request | `scripts/openai.js`, `scripts/secrets.js` |
| Extensions | Inventory/runtime diagnostics, scoped settings and explicitly loaded isolated extension interfaces | `scripts/extensions.js` |
| Plugin management | Operator-enabled Git install, upgrade, remove and selected bulk actions for local extensions and trusted server plugins; revision/trust checks and per-item results, no arbitrary routes or hot loading | Dedicated privileged V1 package-management contract |

Advanced JSON editors preserve original fields instead of reconstructing partial
documents. Settings envelopes/revisions are not editable. A failed write keeps
its draft; no mutation is automatically retried. A different resource name
creates a copy and never inherits the source file's revision. Persona saves use
the inspected persona catalog revision and preserve unknown descriptors on the
server. Reconnecting invalidates old editor clients.

Generation caller metadata is stored before the POST, scoped by origin, account,
target kind and chat. It contains IDs only, not prompts, transcript text or
credentials. A lost response is recovered by GET-by-client, never by POSTing
again. The recovery panel can permanently abandon a not-found key; unknown
outcomes require inspection, stopped local observation, a drained backend worker
and exact sequence acknowledgement. Shared group chats retain the original group
identity. Corrupt scoped pending metadata blocks new admissions.
Legacy unscoped caller records also block new admissions: look up the caller on
its original server from Generation recovery, verify the returned target, then
explicitly migrate that identity into the current scope. No payload is replayed.

## Plugin management

The **Plugin management** navigation entry appears only when the backend advertises
`resources.packageManagement`. The server operator must explicitly set
`enablePluginManagement: true` in their backend configuration; the default is false.
For `pnpm --dir client dev` and `pnpm start`, this is `data/config.yaml`
(or `<SILLYTAVERN_DATA_ROOT>/config.yaml` when that environment variable is set),
not the repository-root `config.yaml`.
The legacy `enablePackageManagement` key is used only when the new key is absent.
Restart the backend after changing config, then reconnect the client to refresh capabilities.
This is a privileged package-file API, not an extension bridge or arbitrary plugin
route. Both extension and server-plugin rows are identified by kind and folder
name, so identical names in different scopes remain distinct.

Install from a trusted HTTPS Git repository with a safe folder name. Review the
exact target and confirm trust before installing/upgrading; removal requires a
separate exact-target confirmation. New extensions start disabled. Installation
does not run dependency scripts, install packages, authorize extension execution,
or hot-load server code. Server plugins can execute with backend permissions after
a restart when server-plugin execution is enabled: install only code you trust.
Existing unmanaged installations may be inventory-only and explain why.

Select individual rows or all visible manageable rows for bulk upgrade/remove
(up to 32 per action). Filtering does not silently clear hidden selections; the
selection count and review list show the full set. Bulk results report each item
independently; successful items are not rolled back when another fails. Settings
are retained on removal. Restart the backend when the result requires it; this
page does not restart the server.

Management writes use a bounded 120-second client timeout to accommodate Git
preparation. A timeout, conflict or lost response never causes mutation replay:
further writes are blocked until an explicit inventory reload. Inspect backend
state before deciding whether to submit another action. A failed install keeps
its form draft, and navigating away from a draft or running operation warns first.
No real repository is installed by client tests; browser workflows use V1 fixtures.

## Deliberate limits

- Snapshot polling uses the advertised polling fallback; there is no separate
  frontend SSE event cursor implementation.
- Character message mutation lacks an atomic external expected-row/revision
  field in V1. The client checks the displayed row before dispatch and the
  backend fences admissions, but an intervening external writer can still race
  between that check and the mutation. Group mutations also send expectedMessage
  for the backend's atomic row check.
- Extension interfaces run on explicit loading in an opaque-origin sandbox with
  upstream virtual module paths. The runtime provides scoped settings saves,
  templates, frame-local ordered events with late ready listeners, common utility
  functions, local image helpers, i18n, jQuery/Handlebars/DOMPurify/lodash/Moment,
  dialogs with custom buttons/inputs and lifecycle callbacks, Prompt collections,
  slash command descriptors/alias registration and byte-stream SSE decoding.
  `tokenizers.js` provides sync/async length estimates and `guesstimate` using
  `Math.ceil(text.length / 3.35)`, with optional padding for nonempty count inputs.
  These are local estimates, not model tokenization or provider usage.
  `utils.js` sanitizes filenames locally with upstream filename rules and a
  255-byte UTF-8 limit, and extracts character filenames when `manualAvatarKey`
  is supplied. Character-catalog lookup remains unbound. Its Font Awesome picker
  accepts explicit lists of alias arrays (up to 4096 icons, 32 aliases per icon,
  128 characters per alias), filters aliases and returns the selected primary
  name, an empty string for No Icon, or null on cancellation. Text labels work
  without packaged fonts; default icon discovery and sandbox downloads reject.
  `/script.js` also exports prompt type/role and system-message constants,
  case-sensitive role lookup, shared occurrence/parity helpers and memoized lazy
  fields. Avatar constants are upstream identifiers, not served asset URLs.
  Its `user_avatar` re-export follows Persona selections before `PERSONA_CHANGED`
  listeners run; `main_api` and `getContext().mainApi` share the captured API kind.
  `name1` and `getContext().name1` use the Persona catalog's revision-bound
  `username`, independently of its selected descriptor name or account identity.
  Successful native Persona reads/selections update the live name binding before
  listeners run; failed or stale responses cannot publish a new name. The parent
  rejects missing/non-string names or names over 65536 UTF-16 code units.
  `name2` and `getContext().name2` use the selected card name, or the source's idle
  group name (`''`) / initial no-selection name (`SillyTavern System`). This is
  frame selection state, not native group-generation speaker tracking. Card names
  remain fixed until extension reload. Generation activity and the prompt
  injection registry remain unbound.
  `is_send_press` is a live read-only export of the selected character
  conversation's native submission and observed worker activity. `isGenerating()`
  (also in context) includes group-batch activity; per-member group phases are
  not inferred. Frames receive an initial state before module execution and live
  parent updates. A terminal worker remains active until drained; a drained
  unknown outcome remains subject to recovery controls without appearing active.
  Newer sequence observations override stale history. Preview and send-button
  locks do not change these values. Settings-only hosts begin idle, and this is
  not a process-wide or cross-tab activity query. No synthetic lifecycle events,
  generation/cancellation authorization or extra provider requests are added.
  `online_status` and context `onlineStatus` read a validated native
  `/provider-status` observation. They return `Valid` only after an explicit
  **Check provider connection** action in API settings successfully reads the
  saved provider's model catalog. Initial, pending, failed, expired or invalidated
  observations use `no_connection`; configured keys, unrelated model discovery
  and previous generations never imply connectivity. Checks send no generation.
  The parent polls local observations sequentially every five seconds after frame
  startup, without invoking provider checks. Binding updates precede source-style
  `ONLINE_STATUS_CHANGED` notifications; duplicate values produce no event.
  Backend read failures clear a previous connected observation. Reload, unmount,
  abort and session replacement dispose observation timers and discard pending
  replies. Checks/results are user/connection-bound and expire after five minutes;
  settings/key changes invalidate them. Status does not verify model generation.
  Importing `/script.js`, `st-context.js` or `extensions.js` initializes their
  Persona/reasoning/OpenAI dependencies once per startup, even without direct imports
  of those modules. `/script.js` and context imports also initialize a complete,
  detached native character catalog (up to 512 cards, 4 MiB per response and
  16 MiB aggregate), rechecking catalog identities/revisions before publication.
  `characters` and `getContext().characters` share the deeply frozen snapshot;
  `this_chid`/`getContext().characterId` is its selected array index, never a
  native character slug. Conversation hosts capture their selected character or
  group/chat identity; settings hosts select none. `getCurrentChatId()` and
  context `chatId` return that bound chat ID or `undefined` without a selection.
  Group hosts expose `getContext().groupId` and no selected character index.
  Only the selected character's `chat` is overridden with the actual open chat.
  No default filename, statistics or transcript is fabricated. Snapshots stay
  fixed until extension reload; changes require reload, not silent refresh.
  `chat` / `chat_metadata` and context `chat` / `chatMetadata` share a separate
  deeply frozen complete snapshot of the selected native conversation. Its
  parent-only `chat.snapshot` operation accepts `{}` and cannot be retargeted.
  Character and group snapshot GETs validate one no-follow file with strict
  UTF-8/JSONL, at most 8 MiB / 10000 messages. Failures reject without empty
  fallbacks or clipping. Metadata and raw messages come from the same read;
  the header is excluded, without adding native paging indexes. Legacy
  headerless groups supply empty metadata in memory only. Settings hosts expose
  the initial empty no-selection state and issue no transcript request.
  These snapshots stay fixed until extension reload, including after a native
  redraw. This implements read compatibility only; transcript/metadata saves
  remain guarded and raw stored reasoning/text is never macro-evaluated here.
  `/script.js` provides `getMaxContextTokens()`, `getMaxResponseTokens()` and
  `getMaxPromptTokens(overrideResponseLength)`, using the captured Chat Completion
  limits. The deprecated `getMaxContextSize` is the same function as
  `getMaxPromptTokens`, returning context minus reserved response tokens.
  Positive response overrides follow upstream behavior, including fractional
  values and unclamped negative remaining budgets. Missing limits and other APIs
  reject; no generation is dispatched and native prompt packing is unchanged.
  These local helpers do not create a native chat or character binding.
  `loadWorldInfo` reads native book data through a named parent operation backed
  by V1; it cannot mutate books or select arbitrary API paths. The parent bounds
  concurrent reads, retains authentication and discards stale session replies.
  `world-info.js` also captures the book catalog, selected books, supported scan
  settings and global/extra-character bindings with bounds and revision checks.
  Its exported arrays/objects are detached; opaque settings and unsupported
  budget controls are omitted. Entry definitions/templates and character-book
  conversion follow upstream and operate only on caller-owned data. Book writes,
  native settings, scanning and editor UI remain unavailable.
  `extensions.js` reads installed names/types (with local-over-global precedence),
  excluding manifests, settings and connection data. This does not execute or
  grant access to other extensions. `saveMetadataDebounced` rejects immediately
  without a bound chat lifecycle. Reload the frame to refresh these snapshots.
  `personas.js` exposes the live `user_avatar`, registered Persona IDs through
  `getUserAvatars(false)` and revision-checked `setUserAvatar`, emitting the local
  `PERSONA_CHANGED` event after success. Selection is unavailable in read-only
  hosts and stops after a failed/uncertain write until reload. This catalog is a
  subset of upstream avatar files; upstream rendering/navigation, media URLs and
  greeting retriggering are unsupported. `reasoning.js` parses upstream response
  reasoning shapes using explicit overrides or four scalar settings captured at
  initialization (identifier strings are bounded to 256 characters); it does not
  enable additional provider dispatch. Persona, settings and identity replies
  are discarded if the bound session changes or aborts while awaiting the API.
  `user.js` initializes account mode/admin/handle from the authenticated session
  before extension imports. `isAdmin()` and `getCurrentUserHandle()` preserve
  upstream single-user defaults. These helpers grant no backend authority;
  malformed or older session responses fail instead of guessing privileges.
  Account UI and `currentUser` are unsupported; `setUserControls()` rejects.
  `macros.js` provides a frame-local legacy `MacrosParser` registry with value
  conversion, iteration and environment population; it never evaluates callbacks
  on registration. `getLastMessageId()` reads the complete snapshot, preserving
  upstream zero-based positions, the `exclude_swipe_in_propress` option spelling,
  unfinished-swipe skipping and caller filters. No selection/no match returns
  `null`; filter errors propagate without persistence or generation.
  Global prompt integration, the experimental registry, `evaluateMacros()` and
  `initMacros()` remain unsupported; no native generation macro is installed.
  `openai.js` exposes local text message/collection/completion models, caller-owned
  token handlers, model selection, provider constants and stream text/reasoning
  parsing. Default message counts estimate serialized JSON string length, never
  provider usage. Its read-only settings snapshot includes only source, model IDs,
  the thoughts switch and configured context/response token limits (safe integers,
  context positive and response nonnegative). Missing limits are not filled in.
  Native generation, prompt/chat setters, proxy settings,
  upstream error UI and media mutation remain unavailable. Stream parsing does
  not validate completion or authorize tools; media support checks return false.
  `preset-manager.js` reads OpenAI/Context/Instruct/System Prompt catalogs and
  active snapshots, with upstream name/value lookup, detached preset lists and
  selected-vs-file extension-field reads. Private connection/credential fields
  are excluded recursively. Loads are bounded and revision-checked, use at most
  four concurrent GETs and do not silently retry failed snapshots. Preset writes,
  selection, live UI/settings serialization and unsupported API managers remain
  unavailable. Reload the frame to observe native changes.
  `extensions/regex/engine.js` supplies the upstream constants, regex compiler/LRU
  cache, literal text replacement and placement/depth/edit/display filtering.
  Detached global/current-preset scripts and explicit scope grants are captured
  through bounded, revision-checked V1 reads; preset rules run only when granted.
  Known script fields are projected without opaque settings or connection data.
  Character rules are empty in this settings-only frame. Macro-dependent
  execution, script saves and scope changes reject explicitly; no native rules
  or transcripts are changed. Reload to observe native regex/preset edits.
  `authors-note.js` exposes metadata keys/module name and the upstream no-chat
  branch (`shouldWIAddPrompt:false`); chat injection and author-note UI remain
  unsupported. `constants.js` supplies shared debounce/injection/media/swipe
  constants. `power-user.js` exposes pure enums (including the shared Persona
  position object), with live state and stopping-string writes rejected.
  `RossAscends-mods.js` provides Bowser-based device classification and upstream
  time helpers. Bowser is packaged in the UI snapshot and exposed by `lib.js`;
  upstream navigation, observers and hotkeys are not installed.
  See `lib/extension-runtime/` and `lib/extension-host.ts` for implemented exports.
  Backend module snapshots preserve JavaScript literal boundaries when rewriting
  single/double-quoted static imports/reexports and literal dynamic imports,
  including template literals without substitutions.
  Unknown literal dynamic host imports reject only when invoked. Unknown static
  imports and missing named exports fail visibly. Chat state, generation,
  STscript execution, model tokenizer services, host-owned templates, World Info
  scanning/mutations and preset writes are not implemented in this frame.
  Registering a slash command does not expose it in the conversation UI.
  In particular, this does not yet
  run all of Tavern Helper (JS-Slash-Runner). The reference checkout used for
  this runtime is `../STOriginal/public`, not a runtime dependency. No legacy
  frontend routes are served by the backend.

  `/script.js` also exports `cleanUpMessage` with object and legacy positional
  signatures. Its supported Chat Completion settings-frame path requires an
  explicit `stoppingStrings` array and settings that do not require unbound
  character/user-name stripping. It removes complete/partial stop suffixes,
  applies the detached authorized regex rules, and follows upstream newline,
  invisible-whitespace, end-marker, Markdown and sentence/space cleanup order.
  It rejects native chat/group context, other APIs, default generation stop
  state, required name stripping and active prompt-bias macro expansion.
  Missing settings are errors, not guessed defaults. `/script.js` imports preload
  the cleanup switches and regex snapshot within the four-operation startup
  batches. The named `script.cleanupSettings` parent operation uses only the
  existing `/settings` GET, memoizes success/failure, checks abort/session identity,
  and projects the API kind, six booleans, a prompt-bias presence flag and the
  optional context example separator. Bias and separator inputs are each bounded
  to 64 KiB UTF-8; bias text, context story templates and surrounding configuration
  never cross into the frame. There is no prompt-reasoning instance in this
  settings frame, so space trimming uses the upstream no-instance branch.
  `power-user.js` exports pure `collapseNewlines` and `fixMarkdown` helpers;
  `utils.js` exports `trimToEndSentence`. These helpers need no native state.
  `/script.js:baseChatReplace` handles literal card fields, collapsing newlines
  before removing CR characters and preserving non-string/empty inputs. Curly
  macros and legacy angle-bracket name aliases reject without a native macro
  context. `/script.js:parseMesExamples` follows upstream block splitting,
  whitespace, empty-block and heading rules using the captured context separator;
  macros in example bodies remain literal, while macro-bearing separators reject.
  OpenAI and explicit Instruct headings are supported as local formatting only.
  `/script.js:printMessages` and `getContext().printMessages` redraw the selected
  native conversation when the extension is loaded using the **Extensions**
  button inside that conversation. The parent reads the most recent 100 stored
  rows through the existing V1 paging/render resource, preserves the display
  projection setting, waits for React's exact DOM commit and scrolls to the last
  message before acknowledging completion. The call returns `undefined` and
  never transmits transcript data to the frame or writes messages. Older rows
  remain accessible through native paging; the upstream SPA DOM, media hooks,
  mutable `chat` array and configurable `chat_truncation` are not recreated.
  The settings-only host rejects this call because no conversation is bound.
  Aborts, replaced sessions, native reloads, overlapping requests and active raw
  editors reject rather than report a successful render. Composer drafts stay
  intact. These adapters still do not establish complete Tavern Helper startup.
  `saveChatConditional`, `saveMetadata` and `saveChat` are importable async
  `/script.js` functions. As in upstream, `getContext().saveChat` aliases
  `saveChatConditional`; the other save aliases retain their function identity. They currently
  reject with an explicit unbound chat persistence error: the frame has no
  complete mutable transcript snapshot or save lifecycle. No backend request
  is issued and no successful save is claimed; native paging, settings saves
  and redraws are not substitutes for transcript persistence.
  `deactivateSendButtons` and `activateSendButtons` (also in `getContext()`)
  asynchronously disable native sending/reply-alternative selection and release
  the calling frame's lock. Other sessions' locks, busy state and unresolved
  generation fences remain effective. Frame close/reload/session abort releases
  its lock. Settings-only hosts reject; these adapters do not implement upstream
  stop-button events or DOM globals, authorize generation or cancel backend work.
  Further native-dependent function imports (including `saveCharacterDebounced`,
  character/catalog/navigation operations and message DOM formatting) link as explicit guards. They fail before queuing timers, reading
  supplied options or issuing requests. No complete mutable chat/catalog or
  character-editor draft is fabricated. `substituteParams` and deprecated
  `substituteParamsExtended` support literal-only coercion/passthrough and reject
  curly or legacy name macros; option callbacks never execute on this path.
  `extractMessageBias` follows upstream's isolated Handlebars helper semantics;
  `getBiasStrings` supports only continue/impersonate bias suppression.
  `unshallowCharacter(undefined)` preserves the upstream early return; loaded
  cards and unknown indices also resolve without fetching, as upstream does for
  a fully loaded catalog. Pre-initialization explicit IDs reject. Catalog
  refresh/edit/navigation operations remain guarded. `stopGeneration` notifies only
  frame-local listeners and returns `false` (no active host-owned processor or
  controller). It never cancels native work or claims a successful stop.
- No chat import/export/search/backups, character filename rename/duplicate,
  Persona image uploads, media, slash commands, arbitrary
  plugin execution or client tool execution is exposed. These require additional
  versioned contracts/lifecycles. Selecting templates does not enable unsupported
  text-completion or Instruct modes.
- The upstream-copy port in `compat-source/v1-client/` remains separate and is
  not rewritten by this client implementation.

## Verification

```sh
pnpm --dir client build
NODE_OPTIONS=--experimental-vm-modules pnpm exec jest --config tests/jest.config.json --runInBand client-i18n.test.js client-presets.test.js client-workspace.test.js client-package-management.test.js api-v1-presets.test.js api-v1-package-management.test.js
CLIENT_BROWSER_TEST=1 NODE_OPTIONS=--experimental-vm-modules pnpm exec jest --config tests/jest.config.json --runInBand client-browser.test.js
```

The opt-in browser test uses installed headless Chrome (override with
`CHROME_BIN`) and the existing `ws` package. It starts a local production Next
server and intercepts V1 requests with explicit fixtures; it makes no billable
provider calls. Set `CLIENT_SCREENSHOT_DIR` to retain its mobile screenshot.
API suites independently verify backend behavior. Neither proves execution on an
Android device.

The browser suite also simulates Grammarly-style attributes injected into `body`
before hydration and checks the client-owned `/favicon.ico`. Set
`CLIENT_BROWSER_DEV=1` alongside `CLIENT_BROWSER_TEST=1` to run against a separate
Next development build (`.next-browser-dev`) and check development hydration
warnings. Only expected attribute differences on `body` are suppressed;
descendant hydration diagnostics remain enabled. The browser suite also loads a
module graph produced by the backend snapshotter, rather than only handwritten
virtual URLs. Build the backend with `pnpm build` before running it.

For extension loading failures, inspect the target module/frame stack before
attributing the error to browser add-ons. The frame has an opaque origin:
`location.origin` is `"null"` and cannot be passed as a `postMessage` target origin.
The extension UI bridge uses `"*"` and checks the message source and per-frame
channel. Keep the iframe sandbox intact; do not suppress extension runtime errors.

Conversation extension hosts on servers advertising `resources.clientExtensionPrompts`
provide a mutable frame-local `extension_prompts` registry, context
`extensionPrompts` alias and `setExtensionPrompt()` with upstream scalar
coercions. Direct edits and deletion are supported within limits. Before a user-initiated
Preview/Generate request is sent, the parent captures each active source,
resolves synchronous/async predicates inside its frame and forwards validated
injections to native prompt assembly. Filters execute once per capture. Errors,
timeouts, duplicate keys or replaced sessions stop submission before admission;
no automatic retry occurs. Settings-only hosts reject registry writes. Reloading
or closing the frame clears injections. No generation completion events are
synthesized; one-shot lifecycle cleanup remains incomplete. Native server
injections are not mirrored into this frame-local registry. See the API extension
reference for bounds and persistence semantics.
