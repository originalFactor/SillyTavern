# SillyTavern Headless

This fork supplies an authenticated `/api/v1` backend, run as a standalone
loopback server or bundled by Messenger's Android `stbridge` app. A separate
Next.js client lives in `client/`; it is not the upstream SillyTavern SPA.
Do not restore or serve the upstream browser SPA or static frontend routes
from the backend.

## API stability

**API v1 is still unstable. Any part of `/api/v1` may change, including breaking
changes, without backward compatibility or a version bump.** Routes, request
and response schemas, behavior, and capability flags are all subject to change.
The `v1` prefix does not imply a stable contract. Keep the API documentation,
behavior tests, and affected clients in sync with contract changes; instability
does not relax the security, persistence, or authorization requirements below.

## Current repository structure

- `src/`: TypeScript backend sources. `headless-server.ts` is the standalone
  entry; `headless-companion.ts` is the Android companion entry.
- `src/endpoints/api-v1.ts`: public V1 router. `src/headless/` owns generation,
  provider dispatch, sessions, resource management, plugins, and extension UI.
  Its `macro-runtime/`, `prompt-runtime/`, and `world-info-runtime/` directories
  hold the source-derived compatibility runtimes.
- `src/types/`: ambient/runtime declarations; other retained backend helpers
  live alongside `src/middleware/`, `src/png/`, `src/validator/`, and `src/vectors/`.
- `client/`: separate Next.js/React V1 client with `app/`, `components/`, `lib/`,
  and development scripts. It has its own `package.json` and `pnpm-lock.yaml`;
  use `pnpm --dir client ...` for client commands. See `client/README.md`.
- `scripts/`: backend development watcher, companion bundle builder, and minimal
  compatibility client. `vite.config.js` and `tsconfig*.json` configure backend
  builds and type checking.
- `dist/src/`: generated Node ESM `.js` modules, including worker entry points.
  Edit `src/**/*.ts`, not generated output. Source imports intentionally retain
  NodeNext `.js` specifiers.
- `default/`: packaged configuration, content/presets, and scaffold;
  `plugins/`: server plugin location; `data/`: local runtime state, not source.
- `docs/api/v1/{README.md,openapi.yaml}`: API guide and schema.
  `docs/building.md`, `docs/compatibility.md`, and
  `docs/android-extension-host.md` cover builds and integration limits.
- `tests/`: Jest behavior/integration tests plus client and opt-in browser tests.
  Backend suites import built modules from `dist/src/`; build before testing
  source changes.
- `compat-source/upstream/` is the historical upstream-authority location
  referenced below, but is absent from this checkout. Do not assume those files
  are available or claim comparison against them without restoring/locating the
  authorities. Preserve them if restored; never serve them as frontend assets.
  The Android/Gradle consumer is also maintained outside this repository.

## Backend and compatibility invariants

- Use pnpm exclusively for JavaScript dependency management and test execution.
  `pnpm-lock.yaml` is the companion dependency lockfile; do not add other
  package-manager lockfiles or commands.
- `dist/src/headless-companion.js` binds 127.0.0.1 only and authenticates every
  request with a fresh capability. Never expose secret values in API responses,
  URLs or logs. Provider credentials are configured through presence-only reads
  and explicit write/delete endpoints; deletion clears all keys for that source.
- `src/endpoints/api-v1.ts` owns the public contract. Update
  `docs/api/v1/{README.md,openapi.yaml}` and behavior tests alongside changes.
  Capability flags describe implemented behavior, not planned compatibility.
- Provider dispatch never follows redirects or replays a request. A bounded SSE stream needs an explicit terminal marker/reason; an interrupted or malformed stream is `unknown`, keeps partial text in its generation journal and never commits a transcript row. Provider HTTP status/detail are visible after credential redaction. Settings/preview responses redact credential fields and custom headers; secret storage remains write-only. Keep these checks when adding provider formats.
- Generation runtime rechecks terminal/cancelled state after every awaited lifecycle/output hook and before persistence. A cancelled turn must not later write transcript rows or queued extension settings. Final observation text preserves the complete bounded output (no 64 KiB slice); quiet completion is `done` with `committed:false` because it creates no transcript row. Keep these semantics in provider/plugin changes.
- `generation-journal.ts` synchronizes a canonical record and permanent caller-key index before dispatch. Memory expiry never permits replay; payload fingerprints detect conflicting reuse. Scoped discovery/read-by-client are observation only; unconfirmed keys can be permanently abandoned, and uncertain outcomes need exact-sequence acknowledgement after local drain. Legacy ambiguous cancellation/error records remain uncertain; retained long/quiet snapshots are repaired where possible. Never silently drop corrupt journals or treat failed writes as successful admission.
- `generation-owner.ts` uses atomic rename of prepared nonempty directories (hard links fail under the Android sandbox). PID/start/boot identity and a serialized recovery guard fence cooperating processes; an interrupted/unverifiable owner requires inspection. Exclude pre-lease legacy/noncooperating writers before upgrading. Headless settings, transcript and journal writes recheck ownership. Partial text receives periodic checkpoints even if no later token arrives.
- Provider settings and the matching vault key are captured together at admission. Vault keys live only in a private WeakMap; they never become serializable session/prompt/journal fields. Accepted workers retain their source/URL/key despite later settings changes; an in-turn source/URL change is rejected before dispatch.
- ST owns JSONL transcripts. Generation commits atomically on success, never
  automatically replays billable requests, and preserves unknown outcomes.
  Regenerate retains swipe alternatives, continue updates the selected swipe,
  and mutation/rename/delete must reject active generation admissions.
- `scripts/build-companion-bundle.mjs` emits the server import graph and
  packaged defaults for Messenger. Android packaging materializes the pnpm
  dependency graph separately; do not require runtime package installation or
  private browser routes in companion mode.
- `src/headless/character-management.ts` owns bounded V1/V2/V3 JSON/PNG/APNG card
  CRUD/import/export. Preserve opaque fields and the supplied card schema;
  replacements/deletion require the inspected PNG digest. Avatar replacement
  preserves card metadata and checks the same digest. Active generation
  admissions fence card mutation. Associated chat deletion needs an explicit
  flag. `src/headless/charx.ts` adds bounded CHARX import/export: `card.json`,
  a PNG icon and declared `embedded://` image assets. ZIP entries, paths and
  uncompressed sizes are checked before reading; auxiliary images are stored
  under the character's owned user-images directory and exported canonically.
  Versioned card fields are preserved. WebP card metadata remains unsupported.
- `src/headless/persona-management.ts` uses standard ST persona settings and a
  persona-only revision, preserving provider settings and unknown descriptor
  fields. In-prompt, depth/role and excluded description placements work;
  legacy position 1 maps to 0. Author-note placements 2/3 use the source-derived
  floating-note/Persona assembly and are separately capability-gated.
  The companion packages a default character and user avatar without the SPA.
- `src/headless/prompt-manager.ts` owns revision-checked active Chat Completion prompt edits and the shared preview/dispatch ordering. Writes are scoped to prompts and global order 100001, preserving provider settings and unrelated orders; old 100000 orders migrate with the persona marker. Support includes roles, enables, markers, generation triggers, depth/priority injection and card main/PHI overrides. Keep `promptManagerPresets` false: full macros and Instruct remain incomplete (source packing is implemented below) (named storage/selection is implemented below). Never publish partial ordering as full preset compatibility.
- Existing ST tool-invocation rows are reconstructed in Chat Completion history when `function_calling` is enabled. Invalid stored calls fail before provider dispatch and the final prompt audit counts the outgoing calls. New calls require a separate authorization and execution lifecycle; keep `toolCalling` false until it is implemented.
- Provider SSE decoding accumulates bounded, indexed tool-call fragments and usage through stream completion. Incomplete, malformed or interrupted calls remain unknown. Complete calls without an admitted client tool catalog report unsupported. Calls matching an admitted catalog require the revision-bound client batch lifecycle below.
- A tool-call stream with a non-tool finish reason or conflicting finish reasons is unknown, even when its current arguments happen to parse. A standalone `[DONE]` remains accepted for compatible providers that omit finish reasons.
- Unsupported completed tool proposals are stored in the generation journal only after credential redaction and exposed through `toolCalls` for observation. Redacted proposals are not execution inputs or authorization receipts.
- `client-tools.ts` provides revision-bound client-executed tool batches for
  character normal/regenerate Chat Completion requests with function calling
  enabled. Catalogs describe tools and never authorize execution. Persist a
  caller-owned execution claim before dispatch. Only a fresh claim response has
  `dispatchAuthorized:true`. Duplicate claims are observation only. Submit one
  complete ordered result set with explicit error flags. Exact repeated receipts
  are idempotent. A restarted/interrupted worker cannot resume tools or provider
  calls. Keep full `toolCalling` false until the native authorization/executor,
  durable local execution ownership and remaining tool flows are implemented.
  Each batch also has `catalogRevision`, the SHA-256 of the ECMAScript
  `JSON.stringify` representation of the admitted tools array. Object keys use
  JavaScript enumeration order; the native catalog computes the same value and
  rejects approval when the current executor catalog no longer matches. The
  digest identifies definitions and never grants execution authority.
  `resources.clientToolBatches` describes the backend contract only. Follow-ups
  retain the admitted connection, run token audits without rerunning macros and
  preserve source ST invocation rows on final commit. Five executed tool rounds
  follow the source recursion limit. Usage is retained per provider call, and
  aggregate fields are published only when every call reports them.
- `src/headless/presets.ts` manages revision-checked named Chat Completion/context/instruct/system templates. Presets use native ST directories and bundled defaults; portable snapshots/exports exclude credentials. Selection checks both file and active-config revisions, requires explicit consent for connection changes, and uses the upstream-checked alias table in `preset-mapping.ts`. Template selection must not enable unsupported modes. Update the bundle/Gradle source inputs when changing packaged defaults.
- `PUT /instruct-mode` changes only the active Instruct enabled switch against the active Instruct revision. `textInstructSettings` advertises the switch used by text-completion assembly; it does not claim complete Instruct compatibility.
- Provider dispatch is limited to OpenAI Chat Completions and compatible custom
  endpoints. Other chat wire formats, including Anthropic Messages and Google
  AI Studio `generateContent`, are unsupported and must fail before dispatch.
  Image/audio input, image generation, TTS, transcription, translation, and
  embeddings remain unsupported in Headless. Keep the corresponding capability
  flags false until they are integrated into managed APIs. Advanced macros, full
  presets/instruct, group chats, and tool execution remain incomplete; do not
  mark them supported without implementation and verification.
- Group display evaluates each paged row in an independent macro frame within one bounded worker job, sharing character contexts across rows to avoid repeated large payloads. Group transcript display projections are separately advertised as `resources.groupChatRender`; raw messages and indexed views share one snapshot, and display evaluation never writes transcript or variables. Historical speakers still in the catalog retain their authorized scoped rules after leaving the group; missing speakers retain global and preset display and edit rules with a warning for unavailable character-scoped rules.
- Group prompt preview is separately advertised as `resources.groupChatPreview`.
  It builds the selected member's prompt with group macros and World Info but
  does not dispatch or persist. Continue preview checks the last speaker. Group
  regeneration removes the trailing generation batch in memory and selects
  speakers again. The first replacement commits that change atomically, and
  later failures retain completed replacements. Regenerate preview uses the
  same batch boundary. Group actions journal per-call usage and partial commits. Keep
  `features.groupChats` false until the complete lifecycle and native device flow
  are verified and remaining group compatibility is implemented.
  Group chat filenames are shared across group descriptors, so admissions,
  mutation fences and discovery use the chat ID across groups; discovery returns
  the original group ID so the blocking outcome can be inspected.
  Group chat creation reserves a new file exclusively before updating the group
  descriptor and removes it if the descriptor update fails. An abrupt process
  exit between those writes can leave an unattached file for inspection.
  Individual group chat deletion checks the revision, shared references and
  generation fence, and restores the reference if file removal fails. A process
  exit after descriptor publication can leave an unattached file for inspection.
  Group swipe selection validates the on-disk paged index, including legacy
  headerless transcripts, and checks the shared chat admission fence before writing.
  Group message deletion also checks that the displayed row matches the stored
  message before deleting, including for chats shared by multiple groups.
  Group message editing evaluates native regex and macros with the message's
  character and group context, then rechecks the group revision, transcript and
  shared admission fence before publishing. For user messages it uses the first
  available member as the character context. Preserve headerless chat indices
  unless local macro effects require adding a metadata header.
  When no group member is activated, a submitted user message still receives
  input regex and macro processing. The first available member supplies the
  character context; missing cards use an empty character context. Cancellation
  during the completion hook prevents publishing the computed message or effects.

## Build and verification

Use Node.js 20 or newer and pnpm. Backend commands run from the repository root:

```sh
pnpm install
pnpm build
pnpm dev
# Or run the built standalone server:
pnpm start
# Build the Android companion bundle:
pnpm build:companion
```

`pnpm build` runs type checking and the Vite Node SSR build, preserving the
runtime module tree under `dist/src/`. `pnpm dev` rebuilds/restarts the backend;
it does not serve the client. Start the separate client with
`pnpm --dir client install` and `pnpm --dir client dev`, or verify its production
build with `pnpm --dir client build` and lint with `pnpm --dir client lint`.
The client's development launcher manages its backend connection; do not expose
its capability in logs or persist it in browser storage.

After building, run the backend suite with `pnpm test --runInBand`, or select
focused suites for the changed behavior. These commands are verification
instructions, not a claim that checks have already passed:

```sh
NODE_OPTIONS=--experimental-vm-modules pnpm exec jest --config tests/jest.config.json --runInBand api-v1-generation-owner.test.js api-v1-generation-journal.test.js api-v1-generation-lifecycle.test.js api-v1-presets.test.js api-v1-provider.test.js api-v1-prompt-manager.test.js api-v1-character-management.test.js api-v1-integration.test.js api-v1-headless.test.js api-v1-companion.test.js api-v1-bundle.test.js api-v1-plugins.test.js api-v1-macros.test.js api-v1-macro-management.test.js api-v1-world-info.test.js api-v1-world-info-management.test.js api-v1-regex-paths.test.js api-v1-regex-concurrency.test.js api-v1-source-prompt.test.js
pnpm exec eslint src/endpoints/api-v1.ts src/headless/session.ts src/headless/runtime.ts src/headless/prompt.ts src/headless/generation-store.ts
```

Host-side tests do not prove execution of the arm64 Android Node binary.
See `client/README.md` for client suites and the opt-in browser check.

## Source-derived runtime and resource invariants

- Native macro runtime files are maintained manually against both upstream engines and all builtin definition groups. Update these files directly and review compatibility against the preserved upstream authorities under `compat-source/upstream/`.
  `macro-runtime/platform.ts` provides synchronous isolated frames, device facts,
  live variable facades and resource limits without browser globals or secrets.
  Preview never persists macro effects. Actual preparation persists variable
  metadata before awaited hooks/provider dispatch, without committing staged
  transcript rows; repeated observation/admission does not evaluate again.
  Native context is a strict whitelist and participates in caller-key identity.
  `upstreamMacroEngine` is separate from still-false full `advancedMacros`.
  Group/Instruct/extension integration remains unfinished. Legacy variable-category ordering and named system dialogue examples
  are intentional upstream behavior, not bugs to normalize.

- New-chat greetings use the same source-derived engine. Check the chat ID and
  generation fence before evaluating; atomically publish greeting/local variables
  in one transcript write. Global preparation effects may precede publication;
  report uncertainty if later filesystem publication fails, never automatically
  retry. Store greeting warnings with the message for native navigation/recovery.
  Upstream getCharacterCardFields eagerly evaluates original first/alternate
  greetings again during later prompt preparation; preserve that documented
  behavior instead of treating it as an admission replay.

- `macro-management.ts` exposes revision-checked global variables/engine and
  chat-local variables as separate documents. Variable objects are bounded to
  7 MiB serialized UTF-8 for the native bulk editor; reject oversized/corrupt
  state, never truncate it. Global saves merge unrelated settings and check
  strict settings JSON/UTF-8. Chat saves reject active/unresolved admissions and
  strictly validate the complete JSONL file before changing its header, so a
  malformed row cannot silently disappear. Reads do not execute macros; neither
  save replays generations. A scoped variable/engine conflict requires explicit
  reload. Preserve failed native drafts and provider/vault boundaries.

- Prompt preparation is asynchronous in a serialized warm Worker. Keep provider
  keys/URLs/headers on the parent thread. The worker has a 10-second job deadline,
  256 MiB old-generation limit, 32 queued jobs and 64 MiB aggregate input limit;
  results are bounded to 32 MiB. Fail visibly without replay on timeout/crash.
  Recheck cancellation after awaiting preparation and before publishing effects.
- World Info runtime files are maintained manually against the upstream WI scanner, WI regex and author-note/Persona assembly. Review changes against the preserved upstream authorities under `compat-source/upstream/`. Selected books are strict,
  no-follow regular-file snapshots (4 MiB/book, 32 MiB total); unreadable selections
  fail instead of silently disappearing. Sticky/cooldown metadata follows the same
  pre-dispatch persistence boundary as variables; preview never publishes it.
  External WI event hooks remain incomplete. `worldInfoScanner` and
  `personaAuthorNote` do not imply book management, full scoped regex or presets.


- `world-info-management.ts` owns native book CRUD/export, independent WI scan
  settings revisions and chat-binding revisions. Book JSON is strict and bounded
  to 4 MiB/20000 entries; catalogs to 512 files, settings to 1 MiB. Missing/stale
  revisions never overwrite existing books. Selected books must validate before
  settings/chat writes. Metadata edits retain every transcript row and reject
  active/unresolved chat admissions; unrelated settings retain their latest values.
  Primary card links stay in `extensions.world`; Persona links use standard
  descriptors and selected lorebook state. No execution or regex authorization is
  granted by import. Foreign lorebook formats still require conversion.
  Delete never silently unlinks: inspect global/extra character/Persona/card/chat/
  group-chat references synchronously, rejecting unsafe/corrupt/oversized
  inventories (10000 entries/64 MiB aggregate, 4 MiB/card, 8 MiB/chat). A linked or
  uninspectable book remains intact. Management does not establish group support.


- `regex-runtime.ts` reuses generated upstream regex for storage, greetings,
  prompt history, editing and saved display; no simplified fallback remains.
  Preserve source global→preset→character order, role/depth, flags, captures and
  macro substitution. Default storage rules must not run again on every prompt
  or on character fields. New user text/swipes are staged consistently; no user
  row is published before successful generation. Greetings recheck identity and
  admission after awaited evaluation. Message edits recheck the whole transcript
  and admission before publishing effects; newer metadata/rows must win.
- `regex-management.ts` owns independently revisioned global scripts and standard
  scope lists (1 MiB/512 scripts). A separate confirmation grants new/re-enabled
  character/preset scopes; import never grants authority. Preserve unrelated
  extension/provider state and opaque script fields. Grants bind avatar/preset
  names, including future edits, as in upstream. Do not infer trust from a file.
- Rendered transcript reads are projections, never writes: retain raw mes and
  reasoning; isolate/discard proposed variable effects and report diagnostics.
  POST `/chats/:id/render` carries whitelisted native facts privately in the body;
  GET render=true remains available with default facts. Native editors use raw
  text. All regex jobs share the bounded worker. Post-provider failures are
  billable-unknown with raw output retained; cancellation must be rechecked after
  evaluation before any output metadata/text write. `upstreamRegexPaths`,
  `regexManagement` and `renderedTranscript` do not establish full streaming,
  reasoning-in-prompt, slash-command or scoped-management parity; keep full
  `scopedRegex` false until those requirements are complete.


- `prompt-runtime` maintains upstream Prompt Manager/message/token-packing classes,
  helpers, defaults and reasoning manually against ten authorities. Review changes
  against the preserved upstream sources. There is no subset
  assembler or 64-row clipping fallback. Preserve source budget reservation,
  history/example priority, names, role/depth, overrides and notes. Missing dynamic
  markers are implicitly enabled; expose that effective state in the editor and
  honor explicit disables. Prompt/Persona depths follow 0..10000.
- Chat Completion prompt assembly keeps history without local token counting or
  token-budget trimming. Provider limits may reject prompts that exceed context.
  Continue instructions remain in reserved control prompts. All four generation
  kinds have read-only preview with correct regenerate/continue history shapes.
- Usage is reported numeric metadata: never fill absent
  counts with zero. Merge known partial counts/details across SSE and checkpoint
  them with the record, including interruption/formatting failure. Terminal
  reasoning must match stored transformed reasoning. Native UI labels
  backend-reported usage separately. Full dependent preset/Instruct,
  group/media/tool/plugin compatibility remains open; do not flip their flags.
- Tool execution requires explicit authorization and its execution lifecycle.


- Text completion request preparation and model tokenization are not part of this
  backend. Preserve source authorities under `compat-source/upstream/` only for
  compatibility analysis.

- Character-chat sampling is stored under `chat_metadata.messenger_sampling`.
  `chat-sampling.ts` validates and revision-checks edits, fences active and
  unresolved generation, and preserves other metadata. Preview and generation
  merge these values before explicit request overrides. Group chats share their file-backed overrides across group references and use
  the group generation fence. Native group editing remains separate work.
