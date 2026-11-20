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
- `src/headless/prompt-manager.js` owns revision-checked active Chat Completion prompt edits and the shared preview/dispatch ordering. Writes are scoped to prompts and global order 100001, preserving provider settings and unrelated orders; old 100000 orders migrate with the persona marker. Support includes roles, enables, markers, generation triggers, depth/priority injection and card main/PHI overrides. Keep `promptManagerPresets` false: named preset management, token-budget packing, full macros and Instruct remain incomplete. Never publish partial ordering as full preset compatibility.
- Current provider scope remains OpenAI/custom Chat Completions. Advanced
  macros, full presets/instruct, group chats, tools, images, TTS and vectors
  remain incomplete; do not mark them supported without implementation and
  contract/runtime verification.

Focused verification from this checkout:

```sh
NODE_OPTIONS=--experimental-vm-modules pnpm --dir tests exec jest --config jest.config.json --runInBand api-v1-character-management.test.js api-v1-integration.test.js api-v1-headless.test.js api-v1-companion.test.js api-v1-bundle.test.js api-v1-plugins.test.js
pnpm exec eslint src/endpoints/api-v1.js src/headless/session.js src/headless/runtime.js src/headless/prompt.js src/headless/generation-store.js
```

Host-side tests do not prove execution of the arm64 Android Node binary.
