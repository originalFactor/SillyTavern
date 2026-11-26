# Chats

## On this page

- [GET /api/v1/chats/{chatId}](#ep-get-api-v1-chats-chatid)
- [GET /api/v1/chats/{chatId}/snapshot](#ep-get-api-v1-chats-chatid-snapshot)
- [PATCH /api/v1/chats/{chatId}](#ep-patch-api-v1-chats-chatid)
- [DELETE /api/v1/chats/{chatId}](#ep-delete-api-v1-chats-chatid)
- [POST /api/v1/chats/{chatId}/messages](#ep-post-api-v1-chats-chatid-messages)
- [POST /api/v1/chats/{chatId}/render](#ep-post-api-v1-chats-chatid-render)
- [GET /api/v1/chats/{chatId}/sampling](#ep-get-api-v1-chats-chatid-sampling)
- [PUT /api/v1/chats/{chatId}/sampling](#ep-put-api-v1-chats-chatid-sampling)
- [GET /api/v1/chats/{chatId}/variables](#ep-get-api-v1-chats-chatid-variables)
- [PUT /api/v1/chats/{chatId}/variables](#ep-put-api-v1-chats-chatid-variables)
- [GET /api/v1/chats/{chatId}/world-info](#ep-get-api-v1-chats-chatid-world-info)
- [PUT /api/v1/chats/{chatId}/world-info](#ep-put-api-v1-chats-chatid-world-info)

<a id="ep-get-api-v1-chats-chatid"></a>

## GET /api/v1/chats/{chatId}

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/chats/{chatId}`

Read a stable-indexed page of ST chat messages.

**PARAMS**
- `chatId` (path, required; string): Chat filename without `.jsonl`.
- `characterId` (query, required; string)
- `limit` (query; integer)
- `before` (query; integer): Return the newest messages with index below this value.
- `after` (query; integer): Return the oldest messages with index above this value.
- `render` (query; boolean): Add read-only native display projections with default macro facts. Native clients use POST /render to supply device facts privately.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Chat page with total, hasMore and nextBefore.

<a id="ep-get-api-v1-chats-chatid-snapshot"></a>

## GET /api/v1/chats/{chatId}/snapshot

Read one complete raw transcript and metadata snapshot with `characterId` as a
required query parameter. Advertised by `resources.chatSnapshot`. Authentication
is unchanged; responses use `Cache-Control: no-store`.

Returns `{characterId, chatId, revision, headerPresent:true, chatMetadata, messages}`.
`revision` is SHA-256 of the exact file bytes and grants no write authority.
The metadata header is removed from `messages`; remaining rows retain raw text,
reasoning, swipes and opaque fields. No paging index or display transformation
is added. Array positions therefore match upstream chat indexes.

The file must be a no-follow regular file in its owned chat directory, strict
UTF-8/JSONL, at most 8 MiB and 10000 messages, with a valid object metadata
header. Missing files return 404; concurrent file changes return 409; excessive
size/count returns 413; unsafe files, invalid rows or missing/invalid headers
return 422. No partial data, macro evaluation, variable effects or writes occur.
There is no automatic retry or continuation token; oversized chats remain
available through the existing paged interface.

<a id="ep-patch-api-v1-chats-chatid"></a>

## PATCH /api/v1/chats/{chatId}

**METHOD**: `PATCH`

**ENDPOINT**: `/api/v1/chats/{chatId}`

Rename a chat file.

**PARAMS**
- `chatId` (path, required; string): Chat filename without `.jsonl`.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `characterId` (string, required)
  - `newChatId` (string, required)

**RETURN**
- `200`: Chat renamed.
- `404`: Chat not found.
- `409`: Target chat already exists.

<a id="ep-delete-api-v1-chats-chatid"></a>

## DELETE /api/v1/chats/{chatId}

**METHOD**: `DELETE`

**ENDPOINT**: `/api/v1/chats/{chatId}`

Delete a chat file.

**PARAMS**
- `chatId` (path, required; string): Chat filename without `.jsonl`.
- `characterId` (query, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Chat deleted.
- `404`: Chat not found.

<a id="ep-post-api-v1-chats-chatid-messages"></a>

## POST /api/v1/chats/{chatId}/messages

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/chats/{chatId}/messages`

Append, edit, delete or select a swipe by stable index.

**PARAMS**
- `chatId` (path, required; string): Chat filename without `.jsonl`.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `characterId` (string, required)
  - `action` (string, required)
  - `index` (integer): Required for edit/delete.
  - `swipeId` (integer): Required with action swipe; selects a stored assistant alternative.
  - `nativeContext` (object): Optional device and UI facts used during preparation. Preview does not save variable changes; a generation can save them before provider completion. Arbitrary script injection is not accepted.
    - `input` (string): Current composer draft, including when requesting regenerate/continue.
    - `locale` (string): Valid BCP-47 device locale.
    - `timeZone` (string): Valid IANA device time-zone identifier.
    - `isMobile` (boolean)
    - `firstDisplayedMessageId` (integer): Zero-based visible transcript message, excluding the JSONL metadata header.
    - `lastGenerationType` (string): Previously observed generation type for preview; actual dispatch uses its accepted type.
  - `message` (object): Required for append/edit.

**RETURN**
- `200`: Message edited or deleted.
- `201`: Message appended.
- `409`: Active/unresolved admission or transcript changed during evaluation.
- `500`: Publication is unknown; inspect text/variables before another explicit save.

<a id="ep-post-api-v1-chats-chatid-render"></a>

## POST /api/v1/chats/{chatId}/render

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/chats/{chatId}/render`

Read a transcript page with display-ready text and optional client context.

**PARAMS**
- `chatId` (path, required; string): Chat filename without `.jsonl`.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `characterId` (string, required)
  - `limit` (integer)
  - `before` (integer)
  - `after` (integer)
  - `nativeContext` (object): Optional device and UI facts used during preparation. Preview does not save variable changes; a generation can save them before provider completion. Arbitrary script injection is not accepted.
    - `input` (string): Current composer draft, including when requesting regenerate/continue.
    - `locale` (string): Valid BCP-47 device locale.
    - `timeZone` (string): Valid IANA device time-zone identifier.
    - `isMobile` (boolean)
    - `firstDisplayedMessageId` (integer): Zero-based visible transcript message, excluding the JSONL metadata header.
    - `lastGenerationType` (string): Previously observed generation type for preview; actual dispatch uses its accepted type.

**RETURN**
- `200`: Stable-indexed page with raw messages and native display projections. No provider call or transcript write.
- `400`: Invalid native context.
- `422`: Corrupt transcript/card or bounded regex evaluation failure.

<a id="ep-get-api-v1-chats-chatid-sampling"></a>

## GET /api/v1/chats/{chatId}/sampling

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/chats/{chatId}/sampling`

Read the character chat sampling overrides and independent revision.

**PARAMS**
- `chatId` (path, required; string)
- `characterId` (query, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Object containing overrides and revision.
- `404`: Chat does not exist.
- `422`: Transcript or stored sampling is invalid.

<a id="ep-put-api-v1-chats-chatid-sampling"></a>

## PUT /api/v1/chats/{chatId}/sampling

**METHOD**: `PUT`

**ENDPOINT**: `/api/v1/chats/{chatId}/sampling`

Replace character chat sampling overrides with revision checking.

**PARAMS**
- `chatId` (path, required; string)
- `characterId` (query, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `expectedRevision` (string, required)
  - `overrides` (object, required)
    - `model` (string)
    - `temperature` (number)
    - `topP` (number)
    - `frequencyPenalty` (number)
    - `presencePenalty` (number)
    - `maxTokens` (integer)
    - `stop` (array of string)

**RETURN**
- `200`: Saved overrides and new revision.
- `400`: Invalid request.
- `409`: Revision conflict or active or unresolved generation.
- `422`: Invalid transcript or stored sampling.

<a id="ep-get-api-v1-chats-chatid-variables"></a>

## GET /api/v1/chats/{chatId}/variables

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/chats/{chatId}/variables`

Read this chat's variables and revision without evaluating macros.

**PARAMS**
- `chatId` (path, required; string)
- `characterId` (query, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Local variable document; no engine or global settings.
  - `application/json` response (`MacroVariableState` schema)
    - `revision` (string, required): Revision token for the inspected document.
    - `variables` (object, required): Complete JSON variable object, limited to 7 MiB.
    - `experimental` (boolean): Present only in global state; true selects the alternate macro engine.
- `404`: Chat does not exist; reading does not create it.
- `422`: Invalid transcript/UTF-8/header/state or oversized variable document.

<a id="ep-put-api-v1-chats-chatid-variables"></a>

## PUT /api/v1/chats/{chatId}/variables

**METHOD**: `PUT`

**ENDPOINT**: `/api/v1/chats/{chatId}/variables`

Replace only local variables, preserving transcript and other metadata.

**PARAMS**
- `chatId` (path, required; string)
- `characterId` (query, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json` (`LocalMacroVariableEdit` schema)
  - `expectedRevision` (string, required)
  - `variables` (object, required)

**RETURN**
- `200`: Saved local document with its new revision.
  - `application/json` response (`MacroVariableState` schema)
    - `revision` (string, required): Revision token for the inspected document.
    - `variables` (object, required): Complete JSON variable object, limited to 7 MiB.
    - `experimental` (boolean): Present only in global state; true selects the alternate macro engine.
- `404`: Chat does not exist.
- `409`: Variables changed or a generation admission blocks editing.
- `422`: Invalid transcript/UTF-8/header/state or oversized variable document; no partial replacement.

<a id="ep-get-api-v1-chats-chatid-world-info"></a>

## GET /api/v1/chats/{chatId}/world-info

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/chats/{chatId}/world-info`

Read this chat's book binding and independent revision without evaluating macros.

**PARAMS**
- `chatId` (path, required; string)
- `characterId` (query, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Object with name (empty means no chat book) and revision.

<a id="ep-put-api-v1-chats-chatid-world-info"></a>

## PUT /api/v1/chats/{chatId}/world-info

**METHOD**: `PUT`

**ENDPOINT**: `/api/v1/chats/{chatId}/world-info`

Save this chat's book binding, preserving all other metadata and transcript rows.

**PARAMS**
- `chatId` (path, required; string)
- `characterId` (query, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `expectedRevision` (string, required)
  - `name` (string, required): Exact existing book name; empty clears the binding.

**RETURN**
- `200`: Saved name and revision.
- `409`: Binding changed or chat has an active/unresolved generation.
- `422`: Invalid transcript/metadata or unreadable selected book.
