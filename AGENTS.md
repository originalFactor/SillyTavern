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
  replacements/deletion require the inspected PNG digest. Active generation
  admissions fence card mutation. Associated chat deletion needs an explicit
  flag. CHARX/WebP and auxiliary asset transfer remain incomplete.
- `src/headless/persona-management.js` uses standard ST persona settings and a
  persona-only revision, preserving provider settings and unknown descriptor
  fields. In-prompt, depth/role and excluded description placements work;
  legacy position 1 maps to 0, while author-note placements 2/3 explicitly fail.
  The companion packages a default character and user avatar without the SPA.
- `src/headless/prompt-manager.js` owns revision-checked active Chat Completion prompt edits and the shared preview/dispatch ordering. Writes are scoped to prompts and global order 100001, preserving provider settings and unrelated orders; old 100000 orders migrate with the persona marker. Support includes roles, enables, markers, generation triggers, depth/priority injection and card main/PHI overrides. Keep `promptManagerPresets` false: token-budget packing, full macros and Instruct remain incomplete (named storage/selection is implemented below). Never publish partial ordering as full preset compatibility.
- `src/headless/presets.js` manages revision-checked named Chat Completion/context/instruct/system templates. Presets use native ST directories and bundled defaults; portable snapshots/exports exclude credentials. Selection checks both file and active-config revisions, requires explicit consent for connection changes, and uses the upstream-checked alias table in `preset-mapping.js`. Template selection must not enable unsupported modes. Update the bundle/Gradle source inputs when changing packaged defaults.
- Current provider scope remains OpenAI/custom Chat Completions. Advanced
  macros, full presets/instruct, group chats, tools, images, TTS and vectors
  remain incomplete; do not mark them supported without implementation and
  contract/runtime verification.

Focused verification from this checkout:

```sh
NODE_OPTIONS=--experimental-vm-modules pnpm --dir tests exec jest --config jest.config.json --runInBand api-v1-generation-owner.test.js api-v1-generation-journal.test.js api-v1-generation-lifecycle.test.js api-v1-presets.test.js api-v1-provider.test.js api-v1-prompt-manager.test.js api-v1-character-management.test.js api-v1-integration.test.js api-v1-headless.test.js api-v1-companion.test.js api-v1-bundle.test.js api-v1-plugins.test.js api-v1-macros.test.js api-v1-macro-management.test.js
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
