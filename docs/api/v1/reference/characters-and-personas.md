# Characters and personas

## On this page

- [GET /api/v1/characters](#ep-get-api-v1-characters)
- [POST /api/v1/characters](#ep-post-api-v1-characters)
- [GET /api/v1/characters/{characterId}](#ep-get-api-v1-characters-characterid)
- [PUT /api/v1/characters/{characterId}](#ep-put-api-v1-characters-characterid)
- [DELETE /api/v1/characters/{characterId}](#ep-delete-api-v1-characters-characterid)
- [PUT /api/v1/characters/{characterId}/avatar](#ep-put-api-v1-characters-characterid-avatar)
- [GET /api/v1/characters/{characterId}/chats](#ep-get-api-v1-characters-characterid-chats)
- [POST /api/v1/characters/{characterId}/chats](#ep-post-api-v1-characters-characterid-chats)
- [GET /api/v1/characters/{characterId}/export](#ep-get-api-v1-characters-characterid-export)
- [POST /api/v1/characters/import](#ep-post-api-v1-characters-import)
- [GET /api/v1/personas](#ep-get-api-v1-personas)
- [PUT /api/v1/personas/{personaId}](#ep-put-api-v1-personas-personaid)
- [DELETE /api/v1/personas/{personaId}](#ep-delete-api-v1-personas-personaid)
- [POST /api/v1/personas/{personaId}/select](#ep-post-api-v1-personas-personaid-select)

<a id="ep-get-api-v1-characters"></a>

## GET /api/v1/characters

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/characters`

List characters using stable filename-based identifiers.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- See the HTTP status and response schema in OpenAPI.

<a id="ep-post-api-v1-characters"></a>

## POST /api/v1/characters

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/characters`

Create a V1/V2/V3 character card without rewriting its schema or unknown fields.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `characterId` (string, required)
  - `card` (object, required)

**RETURN**
- `201`: Card created with its revision digest.
- `409`: ID already exists or an active generation fences this character.

<a id="ep-get-api-v1-characters-characterid"></a>

## GET /api/v1/characters/{characterId}

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/characters/{characterId}`

Read a normalized character card.

**PARAMS**
- `characterId` (path, required; string): Character avatar filename without `.png`.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- See the HTTP status and response schema in OpenAPI.

<a id="ep-put-api-v1-characters-characterid"></a>

## PUT /api/v1/characters/{characterId}

**METHOD**: `PUT`

**ENDPOINT**: `/api/v1/characters/{characterId}`

Replace the exact inspected card revision, preserving its existing PNG image.

**PARAMS**
- `characterId` (path, required; string): Character avatar filename without `.png`.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `card` (object, required)
  - `expectedRevision` (string, required)

**RETURN**
- `200`: Updated card document with new revision.
- `409`: Stale revision or character has an active generation.

<a id="ep-delete-api-v1-characters-characterid"></a>

## DELETE /api/v1/characters/{characterId}

**METHOD**: `DELETE`

**ENDPOINT**: `/api/v1/characters/{characterId}`

Delete a revision-checked character; associated chat deletion requires an explicit flag.

**PARAMS**
- `characterId` (path, required; string): Character avatar filename without `.png`.
- `expectedRevision` (query, required; string)
- `deleteChats` (query; boolean)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Character deleted.
- `409`: Stale revision

<a id="ep-put-api-v1-characters-characterid-avatar"></a>

## PUT /api/v1/characters/{characterId}/avatar

**METHOD**: `PUT`

**ENDPOINT**: `/api/v1/characters/{characterId}/avatar`

Replace the PNG avatar while retaining the card and checking its revision.

**PARAMS**
- `characterId` (path, required; string): Character avatar filename without `.png`.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `expectedRevision` (string, required)
  - `dataBase64` (string, required): Canonical base64 PNG or APNG bounded to 4 MiB.

**RETURN**
- `200`: Updated card document and revision.
- `409`: Stale revision or active generation.
- `422`: Invalid PNG image.

<a id="ep-get-api-v1-characters-characterid-chats"></a>

## GET /api/v1/characters/{characterId}/chats

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/characters/{characterId}/chats`

List JSONL chats for a character.

**PARAMS**
- `characterId` (path, required; string): Character avatar filename without `.png`.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- See the HTTP status and response schema in OpenAPI.

<a id="ep-post-api-v1-characters-characterid-chats"></a>

## POST /api/v1/characters/{characterId}/chats

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/characters/{characterId}/chats`

Create a new chat, optionally seeded with the character greeting.

**PARAMS**
- `characterId` (path, required; string): Character avatar filename without `.png`.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `chatId` (string, required)
  - `firstMessage` (string): Overrides the card greeting; omitted uses the card's first_mes. Greeting text is expanded once; variable changes occur before the chat is created. An existing chat ID is rejected before evaluation.
  - `nativeContext` (object): Optional device and UI facts used during preparation. Preview does not save variable changes; a generation can save them before provider completion. Arbitrary script injection is not accepted.
    - `input` (string): Current composer draft, including when requesting regenerate/continue.
    - `locale` (string): Valid BCP-47 device locale.
    - `timeZone` (string): Valid IANA device time-zone identifier.
    - `isMobile` (boolean)
    - `firstDisplayedMessageId` (integer): Zero-based visible transcript message, excluding the JSONL metadata header.
    - `lastGenerationType` (string): Previously observed generation type for preview; actual dispatch uses its accepted type.

**RETURN**
- `201`: Chat created.
- `409`: Chat already exists.

<a id="ep-get-api-v1-characters-characterid-export"></a>

## GET /api/v1/characters/{characterId}/export

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/characters/{characterId}/export`

Export the current character as JSON, PNG or a bounded CHARX archive.

**PARAMS**
- `characterId` (path, required; string): Character avatar filename without `.png`.
- `format` (query; string, json | png | charx)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Native file-picker envelope.
  - `application/json` response
    - `fileName` (string, required)
    - `mimeType` (string, required)
    - `dataBase64` (string, required)

<a id="ep-post-api-v1-characters-import"></a>

## POST /api/v1/characters/import

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/characters/import`

Import one JSON, PNG/APNG or CHARX card using a caller-owned character ID.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `characterId` (string, required)
  - `format` (string, required)
  - `dataBase64` (string, required)

**RETURN**
- `201`: Imported card document with revision.
- `413`: Card or image exceeds the documented size limit.
- `422`: Malformed or unsupported card format.

<a id="ep-get-api-v1-personas"></a>

## GET /api/v1/personas

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/personas`

Read a persona-only catalog with selectedId and a revision independent of provider settings.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Persona catalog. No unrelated settings or credentials are returned.

<a id="ep-put-api-v1-personas-personaid"></a>

## PUT /api/v1/personas/{personaId}

**METHOD**: `PUT`

**ENDPOINT**: `/api/v1/personas/{personaId}`

Save a persona using standard SillyTavern name/description/placement settings.

**PARAMS**
- `personaId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `expectedRevision` (string, required)
  - `name` (string, required)
  - `description` (string, required)
  - `title` (string)
  - `position` (integer)
  - `depth` (integer)
  - `role` (integer)
  - `lorebook` (string): Existing native book name; empty clears the Persona binding.
  - `select` (boolean)

**RETURN**
- `200`: Updated persona catalog. Unknown descriptor fields are preserved.
- `409`: Persona revision changed.
- `422`: Persona placement/role/depth is invalid.

<a id="ep-delete-api-v1-personas-personaid"></a>

## DELETE /api/v1/personas/{personaId}

**METHOD**: `DELETE`

**ENDPOINT**: `/api/v1/personas/{personaId}`

Remove a persona and its avatar while preserving existing chat messages.

**PARAMS**
- `personaId` (path, required; string)
- `expectedRevision` (query, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Updated persona catalog; deleting the selected persona resets the active name to User.

<a id="ep-post-api-v1-personas-personaid-select"></a>

## POST /api/v1/personas/{personaId}/select

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/personas/{personaId}/select`

Select the persona for subsequent generation requests without rewriting existing history.

**PARAMS**
- `personaId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `expectedRevision` (string, required)

**RETURN**
- `200`: Updated persona catalog.
