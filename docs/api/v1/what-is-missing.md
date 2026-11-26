# What is missing from the V1 client/API port

This is the working gap list for the isolated client copy at
[`compat-source/v1-client/`](../../compat-source/v1-client/). The copy is an
unmodified upstream baseline today; it still calls legacy routes. This document
records the functions that cannot yet be ported to V1 without a contract change,
and the supported functions that still need request/response adaptation.

For every function changed in the copy, check the relevant section of the
[client implementation guide](client-implementation.md) first. Then verify the
route and schema in [`openapi.yaml`](openapi.yaml). Update this matrix in the
same change. A function is only ported when it calls V1 (or a documented
compatibility endpoint), handles V1 errors/revisions, and has no legacy-route
fallback.

## Supported functions that need porting

The separate Next client in [`client/`](../../../client/README.md) now implements
the supported resource subset listed below through V1-only calls. Its coverage,
reference-source mapping, draft/recovery guarantees and remaining UI limits are
documented there. This does **not** mark the original copied functions in
`compat-source/v1-client/` as migrated, or establish full upstream compatibility.
The missing API operations below remain unavailable; the new client has no
legacy endpoint fallback.

These upstream behaviors have V1 equivalents, but their original client
functions still use legacy endpoints or state assumptions. They are migration
work, not API gaps.

| Upstream function or area | Current source | V1 equivalent | Porting notes |
| --- | --- | --- | --- |
| Initial session/settings load and save | `script.js`: `firstLoadInit`, `getSettings`, settings save flow | `GET /session`, `GET/PATCH /settings`, `GET /capabilities` | Remove CSRF bootstrap in companion mode; capability-gate controls; use redacted settings and patch semantics. See guide: Connection; Settings. |
| Character list/read/create/edit/delete/import/export/avatar | `script.js`, `scripts/characters.js` | `/characters` resource family | Map avatar URLs to stable `characterId`; preserve card schema and unknown data; include expected revision; verify supported card formats. See guide: Characters, personas, and groups. |
| Character chats and transcript read/edit/delete/rename/create | `script.js` | `/characters/{id}/chats`, `/chats/{id}` and message routes | Convert the legacy full-chat load/save model to pages and explicit mutations. Preserve server row indexes, revisions, generation fences, and raw/display distinction. See guide: Chats and transcript presentation. |
| Group list/create/edit/delete and supported group chat flows | `scripts/group-chats.js` | `/groups`, `/groups/{id}/chats` and group message/generation routes | Use granular capability flags; include group ID for group operations; key shared chat state/fences by chat ID. Full group parity remains false. See guide: Characters, personas, and groups. |
| Persona list/edit/select/delete | `scripts/personas.js` | `/personas` | Persona descriptors are not the upstream avatar upload API. Image/avatar operations need separate support. Use persona revisions. See guide: Characters, personas, and groups. |
| Presets and Prompt Manager | `scripts/preset-manager.js`, `scripts/PromptManager.js` | `/presets`, `/preset-settings`, `/prompt-manager`, `/instruct-mode` | Preserve opaque values, use revision checks, require consent for connection changes, and leave unsupported modes disabled. See guide: Settings, prompts, presets, macros, regex, and World Info. |
| World Info management and chat/persona bindings | `scripts/world-info.js`, `scripts/personas.js` | `/world-info`, `/world-info-settings`, `/chats/{id}/world-info` | Convert to separate book/settings/binding revisions; surface reference and validation failures. See guide: Settings, prompts, presets, macros, regex, and World Info. |
| Macro variables and regex settings | `scripts/macros.js`, `scripts/variables.js`, regex extension | `/macro-variables/*`, `/regex-settings` | Separate global/local variable docs, preserve drafts on conflicts, and never infer regex execution authorization from import. See guide: Settings, prompts, presets, macros, regex, and World Info. |
| Generation preview, send, cancel, regenerate, continue, swipe | `script.js`, `scripts/openai.js`, `scripts/textgen-settings.js`, group generation code | `/generations/preview`, `/generations`, generation snapshot/events/cancel/ack routes | Replace provider-specific browser request paths with the admitted server runtime. Persist clientRequestId before dispatch; implement unknown recovery and no replay. See guide: Generation composer and controls; State and recovery model. |
| Extension inventory and settings | `scripts/extensions.js` | `/extensions`, `/extensions/{id}/settings`, extension shell | Keep each extension runtime distinct. Do not treat settings support as general extension compatibility. See guide: Plugin support. |

The original function names above are the inventory anchors, not a claim that
their complete upstream behavior is supported by V1. In particular, text
completion request dispatch, full Instruct, media, and full group behavior must
remain unavailable while their capabilities are false.

## Missing V1 API operations

The upstream server implements these operations and the copied client calls
them, but `src/endpoints/api-v1.ts` has no equivalent route or capability.

| Missing operation | Upstream call sites | User-facing behavior blocked | Contract work needed |
| --- | --- | --- | --- |
| Recent-chat discovery | `scripts/welcome-screen.js`: `getRecentChats` → `/api/chats/recent` | Welcome/recent chats, pinned/hidden recents | Add scoped, bounded recent query and capability; define pinned/hidden metadata ownership. |
| Chat search | `script.js`: `displayChats` → `/api/chats/search` | Search chats/messages and result navigation | Add bounded query/paging and safe rendered/raw matching semantics. |
| Chat import | `script.js`: `importCharacterChat` → `/api/chats/import`; group import in `scripts/group-chats.js` | Import legacy chat formats | Define accepted formats, size limits, target IDs, and atomic publication. Do not accept arbitrary filesystem paths. |
| Chat export | `script.js` export flow → `/api/chats/export` | Export chat to upstream formats | Add an export operation with explicit format allowlist and bounded response; avoid filesystem destination paths from client. |
| Chat backup listing, download, delete | `scripts/chat-backups.js`: list/view/restore/delete → `/api/backups/chat/*` | Inspect, restore, and delete server-created chat backups | Add scoped backup references and safe restore lifecycle; restore must fence active/unresolved generations. |
| Character rename and duplicate | `script.js`: duplicate and rename actions → `/api/characters/duplicate`, `/api/characters/rename` | Rename stable character ID; duplicate cards and associated assets | Add explicit ID migration/duplicate contract, collision handling, chat reference behavior, and revision checks. A card `PUT` does not rename its filename identity. |
| Character attribute merge | `script.js`, `scripts/BulkEditOverlay.js`, `scripts/extensions.js` → `/api/characters/merge-attributes` | Bulk card merge and extension-driven card patch | Decide whether V1 card replacement is sufficient; if merge is needed, specify conflict and opaque-field semantics. |
| User avatar image list/upload/delete | `scripts/personas.js` → `/api/avatars/*` | Select, upload, and remove persona avatar images | Add bounded image resource APIs with safe image validation and revision/ownership rules. Persona descriptor APIs do not carry image bytes. |
| Settings snapshots | `scripts/user.js` → `/api/settings/get-snapshots`, `make-snapshot`, `load-snapshot`, `restore-snapshot` | Create/list/restore settings snapshots | Add explicit snapshot resource, immutable identity/revision, preview, and restore conflict behavior. |
| User/admin account operations | `scripts/user.js` → `/api/users/*` | User management, password changes, account reset/logout | Out of the standalone companion client scope unless an authenticated account-management contract is deliberately added. Never route these through V1 by guesswork. |
| Extension install/update lifecycle | `scripts/extensions.js` → `/api/extensions/install`, `update`, `switch`, `delete`, etc. | Install, update, switch, or remove extensions | No V1 equivalent. Extension installation executes third-party code; requires a separately designed trust/consent and server lifecycle contract. |
| Quick Reply CRUD/execution | bundled `scripts/extensions/quick-reply/*` → `/api/quick-replies/*` plus slash-command execution | Edit and run Quick Replies | No V1 route/runtime. Do not map this to generic extension settings; command execution needs a distinct authorization model. |
| Legacy secrets manager operations | `scripts/secrets.js` → `/api/secrets/view`, `read`, `find`, `rotate`, `rename`, etc. | Enumerate and manipulate multiple named secrets | V1 intentionally uses presence-only reads and explicit provider credential write/delete; secret values stay write-only. Value reads, rotation, and alias management are removed by design. Adapt only the supported provider credential flow. |
| Browser settings/assets/theme/UI APIs | Broad UI modules use `/api/settings/*`, `/api/files/*`, `/api/themes/*`, `/api/backgrounds/*`, `/api/thumbnails/*`, `/api/sprites/*` and static routes | Browser shell, themes, backgrounds, asset browsing, arbitrary file operations | These are not general native API resources. Add narrowly scoped resources only when a native feature requires them; never expose arbitrary file access. |
| Provider/model discovery and multimodal media APIs | `scripts/openai.js`, `scripts/textgen-*`, `scripts/horde.js`, extension provider modules | Provider controls, model lists, image/audio input, image generation, speech, transcription, and embeddings | V1 currently admits OpenAI Chat Completions generation only. Do not restore legacy provider routes or direct media proxies without a managed Headless lifecycle. |
| Server plugin management and arbitrary plugin routes | `scripts/extensions.js`, extension-specific modules | Install/manage server plugins or invoke arbitrary plugin APIs | Server plugins are trusted Node code and are not client plugins. No generic V1 route should expose them. See guide: Plugin support. |

## Removed or intentionally unavailable in V1

These upstream calls or assumptions cannot be ported as-is because V1 has a
different security or ownership boundary:

- `/csrf-token`, browser login, and browser ping are not companion API
  operations. The native host performs its companion handshake and sends the
  fresh capability on every request.
- `/api/secrets/view`, `/read`, and `/find` return secret values in the normal
  browser model. V1 deliberately makes provider credentials write-only and
  reports presence only.
- Direct provider HTTP requests from `openai.js`, text-generation modules,
  Horde, or extension code bypass admission, credential capture, journaling,
  redaction, and recovery. Generation must go through V1 generation routes.
- Full browser SPA routes, DOM assumptions, arbitrary local storage, and static
  frontend resources are not part of the companion contract.
- Slash commands, general extension execution, arbitrary server-plugin calls,
  and legacy tool registration do not become supported merely because upstream
  defines them. Use only the explicit extension adapters and capability flags.

## Port completion checklist

For each upstream function migrated in `compat-source/v1-client/`:

1. Name the function and source file in this document's supported/missing
   matrix.
2. Read the matching client guide section and the exact endpoint reference.
3. Replace the legacy request and state mutation with the V1 method, path,
   payload, response, revision, and error lifecycle.
4. Remove its legacy fallback. Unsupported capability means a visible disabled
   action or omitted UI entry, not a hidden legacy request.
5. Verify the function against the documented response and lifecycle, then
   update the row and relevant client guide section in the same change.

The V1-only port is complete only when a static scan of the copied client finds
no reachable legacy SillyTavern `/api/*` calls, and every remaining unsupported
function is removed from navigation or clearly disabled with a link to its gap
entry. External provider calls, extension assets, and local static assets must
be audited separately; they are not substitutes for V1 server operations.
