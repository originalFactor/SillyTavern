# SillyTavern native-companion fork

This fork supplies the versioned `/api/v1` backend bundled by Messenger's
standalone Android `stbridge` app. Preserve the upstream browser app separately
from the companion entry point.

- Use pnpm exclusively for JavaScript dependency management and test execution.
  `pnpm-lock.yaml` is the companion dependency lockfile; do not add other
  package-manager lockfiles or commands.
- `src/headless-companion.js` binds 127.0.0.1 only and authenticates every
  request with a fresh capability. Never expose secret values in API responses,
  URLs or logs. Provider credentials are configured through presence-only reads
  and explicit write/delete endpoints; deletion clears all keys for that source.
- `src/endpoints/api-v1.js` owns the public contract. Update
  `docs/api/v1/{README.md,openapi.yaml}` and behavior tests alongside changes.
  Capability flags describe implemented behavior, not planned compatibility.
- Provider dispatch never follows redirects or replays a request. A bounded SSE stream needs an explicit terminal marker/reason; an interrupted or malformed stream is `unknown`, keeps partial text in its generation journal and never commits a transcript row. Provider HTTP status/detail are visible after credential redaction. Settings/preview responses redact credential fields and custom headers; secret storage remains write-only. Keep these checks when adding provider formats.
- Generation runtime rechecks terminal/cancelled state after every awaited lifecycle/output hook and before persistence. A cancelled turn must not later write transcript rows or queued extension settings. Final observation text preserves the complete bounded output (no 64 KiB slice); quiet completion is `done` with `committed:false` because it creates no transcript row. Keep these semantics in provider/plugin changes.
- `generation-journal.js` synchronizes a canonical record and permanent caller-key index before dispatch. Memory expiry never permits replay; payload fingerprints detect conflicting reuse. Scoped discovery/read-by-client are observation only; unconfirmed keys can be permanently abandoned, and uncertain outcomes need exact-sequence acknowledgement after local drain. Legacy ambiguous cancellation/error records remain uncertain; retained long/quiet snapshots are repaired where possible. Never silently drop corrupt journals or treat failed writes as successful admission.
- `generation-owner.js` uses atomic rename of prepared nonempty directories (hard links fail under the Android sandbox). PID/start/boot identity and a serialized recovery guard fence cooperating processes; an interrupted/unverifiable owner requires inspection. Exclude pre-lease legacy/noncooperating writers before upgrading. Headless settings, transcript and journal writes recheck ownership. Partial text receives periodic checkpoints even if no later token arrives.
- Provider settings and the matching vault key are captured together at admission. Vault keys live only in a private WeakMap; they never become serializable session/prompt/journal fields. Accepted workers retain their source/URL/key despite later settings changes; an in-turn source/URL change is rejected before dispatch.
- ST owns JSONL transcripts. Generation commits atomically on success, never
  automatically replays billable requests, and preserves unknown outcomes.
  Regenerate retains swipe alternatives, continue updates the selected swipe,
  and mutation/rename/delete must reject active generation admissions.
- `scripts/build-companion-bundle.mjs` emits the server import graph and
  packaged defaults for Messenger. Android packaging materializes the pnpm
  dependency graph separately; do not require runtime package installation or
  private browser routes in companion mode.
- `src/headless/character-management.js` owns bounded V1/V2/V3 JSON/PNG/APNG card
  CRUD/import/export. Preserve opaque fields and the supplied card schema;
  replacements/deletion require the inspected PNG digest. Avatar replacement
  preserves card metadata and checks the same digest. Active generation
  admissions fence card mutation. Associated chat deletion needs an explicit
  flag. CHARX/WebP and auxiliary asset transfer remain incomplete.
- `src/headless/persona-management.js` uses standard ST persona settings and a
  persona-only revision, preserving provider settings and unknown descriptor
  fields. In-prompt, depth/role and excluded description placements work;
  legacy position 1 maps to 0. Author-note placements 2/3 use the source-derived
  floating-note/Persona assembly and are separately capability-gated.
  The companion packages a default character and user avatar without the SPA.
- `src/headless/prompt-manager.js` owns revision-checked active Chat Completion prompt edits and the shared preview/dispatch ordering. Writes are scoped to prompts and global order 100001, preserving provider settings and unrelated orders; old 100000 orders migrate with the persona marker. Support includes roles, enables, markers, generation triggers, depth/priority injection and card main/PHI overrides. Keep `promptManagerPresets` false: full macros and Instruct remain incomplete (source packing is implemented below) (named storage/selection is implemented below). Never publish partial ordering as full preset compatibility.
- `src/headless/presets.js` manages revision-checked named Chat Completion/context/instruct/system templates. Presets use native ST directories and bundled defaults; portable snapshots/exports exclude credentials. Selection checks both file and active-config revisions, requires explicit consent for connection changes, and uses the upstream-checked alias table in `preset-mapping.js`. Template selection must not enable unsupported modes. Update the bundle/Gradle source inputs when changing packaged defaults.
- `PUT /instruct-mode` changes only the active Instruct enabled switch against the active Instruct revision. `textInstructSettings` advertises the switch used by text-completion assembly; it does not claim complete Instruct compatibility.
- Current provider scope remains OpenAI/custom Chat Completions. Advanced
  macros, full presets/instruct, group chats, tools, images, TTS and vectors
  remain incomplete; do not mark them supported without implementation and
  contract/runtime verification.
- Group transcript display projections are separately advertised as `resources.groupChatRender`; raw messages and indexed views share one snapshot, and display evaluation never writes transcript or variables. Missing historical speakers retain global and preset display and edit rules with a warning for unavailable character-scoped rules.
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

Focused verification from this checkout:

```sh
NODE_OPTIONS=--experimental-vm-modules pnpm --dir tests exec jest --config jest.config.json --runInBand api-v1-generation-owner.test.js api-v1-generation-journal.test.js api-v1-generation-lifecycle.test.js api-v1-presets.test.js api-v1-provider.test.js api-v1-prompt-manager.test.js api-v1-character-management.test.js api-v1-integration.test.js api-v1-headless.test.js api-v1-companion.test.js api-v1-bundle.test.js api-v1-plugins.test.js api-v1-macros.test.js api-v1-macro-management.test.js api-v1-world-info.test.js api-v1-world-info-management.test.js api-v1-regex-paths.test.js api-v1-regex-concurrency.test.js api-v1-source-prompt.test.js
pnpm exec eslint src/endpoints/api-v1.js src/headless/session.js src/headless/runtime.js src/headless/prompt.js src/headless/generation-store.js
```

Host-side tests do not prove execution of the arm64 Android Node binary.

- Native macro execution derives both upstream engines and all builtin definition
  groups with `scripts/generate-headless-macros.mjs`; generated source hashes and
  bytes are checked during companion packaging. Edit the upstream source or the
  platform adapter, then regenerate; never hand-edit generated files.
  `macro-runtime/platform.js` provides synchronous isolated frames, device facts,
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

- `macro-management.js` exposes revision-checked global variables/engine and
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
- `scripts/generate-headless-world-info.mjs` derives the upstream WI scanner,
  WI regex and author-note/Persona assembly. Packaging checks exact source hashes
  and generated bytes; never edit generated files. Selected books are strict,
  no-follow regular-file snapshots (4 MiB/book, 32 MiB total); unreadable selections
  fail instead of silently disappearing. The evaluator uses the actual OpenAI
  tokenizer with downloads disabled. Sticky/cooldown metadata follows the same
  pre-dispatch persistence boundary as variables; preview never publishes it.
  External WI event hooks remain incomplete. `worldInfoScanner` and
  `personaAuthorNote` do not imply book management, full scoped regex or presets.


- `world-info-management.js` owns native book CRUD/export, independent WI scan
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


- `regex-runtime.js` reuses generated upstream regex for storage, greetings,
  prompt history, editing and saved display; no simplified fallback remains.
  Preserve source global→preset→character order, role/depth, flags, captures and
  macro substitution. Default storage rules must not run again on every prompt
  or on character fields. New user text/swipes are staged consistently; no user
  row is published before successful generation. Greetings recheck identity and
  admission after awaited evaluation. Message edits recheck the whole transcript
  and admission before publishing effects; newer metadata/rows must win.
- `regex-management.js` owns independently revisioned global scripts and standard
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


- `prompt-runtime` derives upstream Prompt Manager/message/token-packing classes,
  helpers, defaults and reasoning from ten authorities. Packaging runs its
  generator --check; never hand-edit generated artifacts. There is no subset
  assembler or 64-row clipping fallback. Preserve source budget reservation,
  history/example priority, names, role/depth, overrides and notes. Missing dynamic
  markers are implicitly enabled; expose that effective state in the editor and
  honor explicit disables. Prompt/Persona depths follow 0..10000.
- Tokenizer AJAX is a local strict call, not network: downloads and guessed counts
  are disabled. The opaque token cache uses bounded collision-resistant keys.
  Source browser code catches partial packing failures for inspection; native
  assembly deliberately rethrows to prevent dispatching that partial prompt.
  An enabled history marker must retain a newly staged nonempty input or fail.
- Audit the final packet after request hooks without rerunning macros. Transfer
  only model/messages/budget, never URLs/credentials/headers/variables, to that
  audit. Recheck cancellation after waiting. Continue instructions belong to
  reserved control prompts, not a post-budget append. All four generation kinds
  have read-only preview with correct regenerate/continue history shapes.
- Usage is reported numeric metadata, not a tokenizer estimate: never fill absent
  counts with zero. Merge known partial counts/details across SSE and checkpoint
  them with the record, including interruption/formatting failure. Terminal
  reasoning must match stored transformed reasoning. Native UI labels tokenizer
  estimates and backend-reported usage separately. Full dependent preset/Instruct,
  group/media/tool/plugin compatibility remains open; do not flip their flags.


- In-progress text completion: generate-headless-text-prompt.mjs derives ten
  artifacts from eleven authorities, including Generate's actual string fitter,
  story/history/first-last/quiet/continue/example/depth rules, CFG and reasoning.
  Check sentinels and source hashes; never hand-edit generated files. Browser
  inspection may leave mandatory/CFG overflow; the native adapter rejects it,
  and rejects omitted newest staged input. Both CFG branches are counted.
  For ordinary joined-string boundary overflow, refit frozen unpinned examples
  then oldest history without expanding macros/events again. Keep the last
  control message, trace the original newest row across depth injection, and
  update the actual context boundary after trimming.
  buildStringPrompt evaluates this path in the existing bounded worker, with
  captured books and isolated macro effects; it never admits or dispatches a
  provider call. Source model/tokenizer matching is offline, explicit remote or
  estimate choices fail, and old Chat Completion budgets/models cannot override
  text settings. Preset regex permissions use the actual API namespace.
  Packaging checks the text generator and ships its full import graph/manifest.
  Keep Instruct/text provider capabilities false until captured transport,
  native configuration and complete preview/generate/recovery verification exist.
  api-v1-instruct-format.test.js and api-v1-text-packing.test.js cover this
  foundation, not full Instruct integration.
- encodeLocalTextTokens uses absolute packaged model paths, exact local encoder
  IDs and no download, fallback encoder or character-count estimate. Model choice
  is whitelisted; a missing asset is explicit failure. It correctly distinguishes
  nerdstash_v2 from nerdstash and does not depend on the process working directory.
