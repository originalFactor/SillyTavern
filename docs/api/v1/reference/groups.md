# Groups

## On this page

- [GET /api/v1/groups](#ep-get-api-v1-groups)
- [POST /api/v1/groups](#ep-post-api-v1-groups)
- [GET /api/v1/groups/{groupId}](#ep-get-api-v1-groups-groupid)
- [PUT /api/v1/groups/{groupId}](#ep-put-api-v1-groups-groupid)
- [DELETE /api/v1/groups/{groupId}](#ep-delete-api-v1-groups-groupid)
- [GET /api/v1/groups/{groupId}/chats](#ep-get-api-v1-groups-groupid-chats)
- [POST /api/v1/groups/{groupId}/chats](#ep-post-api-v1-groups-groupid-chats)
- [GET /api/v1/groups/{groupId}/chats/{chatId}](#ep-get-api-v1-groups-groupid-chats-chatid)
- [DELETE /api/v1/groups/{groupId}/chats/{chatId}](#ep-delete-api-v1-groups-groupid-chats-chatid)
- [POST /api/v1/groups/{groupId}/chats/{chatId}/generations](#ep-post-api-v1-groups-groupid-chats-chatid-generations)
- [POST /api/v1/groups/{groupId}/chats/{chatId}/messages/delete](#ep-post-api-v1-groups-groupid-chats-chatid-messages-delete)
- [POST /api/v1/groups/{groupId}/chats/{chatId}/messages/edit](#ep-post-api-v1-groups-groupid-chats-chatid-messages-edit)
- [POST /api/v1/groups/{groupId}/chats/{chatId}/preview](#ep-post-api-v1-groups-groupid-chats-chatid-preview)
- [POST /api/v1/groups/{groupId}/chats/{chatId}/render](#ep-post-api-v1-groups-groupid-chats-chatid-render)
- [GET /api/v1/groups/{groupId}/chats/{chatId}/sampling](#ep-get-api-v1-groups-groupid-chats-chatid-sampling)
- [PUT /api/v1/groups/{groupId}/chats/{chatId}/sampling](#ep-put-api-v1-groups-groupid-chats-chatid-sampling)
- [POST /api/v1/groups/{groupId}/chats/{chatId}/swipe](#ep-post-api-v1-groups-groupid-chats-chatid-swipe)

<a id="ep-get-api-v1-groups"></a>

## GET /api/v1/groups

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/groups`

List native SillyTavern group descriptors.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Group documents with revision and bounded invalid-file diagnostics.

<a id="ep-post-api-v1-groups"></a>

## POST /api/v1/groups

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/groups`

Create a native group descriptor.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `201`: Created group document with revision.

<a id="ep-get-api-v1-groups-groupid"></a>

## GET /api/v1/groups/{groupId}

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/groups/{groupId}`

Read a group and its revision token.

**PARAMS**
- `groupId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Group document.

<a id="ep-put-api-v1-groups-groupid"></a>

## PUT /api/v1/groups/{groupId}

**METHOD**: `PUT`

**ENDPOINT**: `/api/v1/groups/{groupId}`

Replace a group descriptor with revision checking.

**PARAMS**
- `groupId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Updated group document.
- `409`: Revision conflict.

<a id="ep-delete-api-v1-groups-groupid"></a>

## DELETE /api/v1/groups/{groupId}

**METHOD**: `DELETE`

**ENDPOINT**: `/api/v1/groups/{groupId}`

Delete a group and optionally its explicitly confirmed group chats.

**PARAMS**
- `groupId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Deleted group.
- `409`: Revision conflict or deleteChats confirmation required.

<a id="ep-get-api-v1-groups-groupid-chats"></a>

## GET /api/v1/groups/{groupId}/chats

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/groups/{groupId}/chats`

List group JSONL chats attached to a native group.

**PARAMS**
- `groupId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Attached group chats.

<a id="ep-post-api-v1-groups-groupid-chats"></a>

## POST /api/v1/groups/{groupId}/chats

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/groups/{groupId}/chats`

Attach and initialize a group chat with revision checking.

**PARAMS**
- `groupId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `chatId` (string, required)
  - `expectedRevision` (string, required)

**RETURN**
- `201`: Updated group document.
- `409`: Revision conflict or existing chat file.

<a id="ep-get-api-v1-groups-groupid-chats-chatid"></a>

## GET /api/v1/groups/{groupId}/chats/{chatId}

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/groups/{groupId}/chats/{chatId}`

Read a bounded paged group JSONL transcript.

**PARAMS**
- `groupId` (path, required; string)
- `chatId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Paged group transcript.

<a id="ep-delete-api-v1-groups-groupid-chats-chatid"></a>

## DELETE /api/v1/groups/{groupId}/chats/{chatId}

**METHOD**: `DELETE`

**ENDPOINT**: `/api/v1/groups/{groupId}/chats/{chatId}`

Delete one group chat and update its group descriptor.

**PARAMS**
- `groupId` (path, required; string)
- `chatId` (path, required; string)
- `expectedRevision` (query, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Updated group document.
- `404`: Chat is not attached to the group.
- `409`: Stale revision

<a id="ep-post-api-v1-groups-groupid-chats-chatid-generations"></a>

## POST /api/v1/groups/{groupId}/chats/{chatId}/generations

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/groups/{groupId}/chats/{chatId}/generations`

Admit a durable group generation.

**PARAMS**
- `groupId` (path, required; string)
- `chatId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `clientRequestId` (string, required)
  - `input` (string)
  - `type` (string)
  - `overrides` (object)
  - `nativeContext` (object)

**RETURN**
- `202`: Accepted or previously admitted generation.
- `409`: Conflicting request identity or unresolved generation.
- `422`: Unsupported generation type.

<a id="ep-post-api-v1-groups-groupid-chats-chatid-messages-delete"></a>

## POST /api/v1/groups/{groupId}/chats/{chatId}/messages/delete

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/groups/{groupId}/chats/{chatId}/messages/delete`

Delete an unchanged group message.

**PARAMS**
- `groupId` (path, required; string)
- `chatId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `index` (integer, required)
  - `expectedMessage` (object, required)

**RETURN**
- `200`: Message deleted.
- `404`: Message or chat not found.
- `409`: Message changed or chat has an active or unresolved generation.

<a id="ep-post-api-v1-groups-groupid-chats-chatid-messages-edit"></a>

## POST /api/v1/groups/{groupId}/chats/{chatId}/messages/edit

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/groups/{groupId}/chats/{chatId}/messages/edit`

Edit an unchanged group message using native text processing.

**PARAMS**
- `groupId` (path, required; string)
- `chatId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `index` (integer, required)
  - `expectedMessage` (object, required)
  - `text` (string, required)
  - `nativeContext` (object)

**RETURN**
- `200`: Message edited.
- `409`: Group or transcript changed
- `422`: Message character is unavailable.

<a id="ep-post-api-v1-groups-groupid-chats-chatid-preview"></a>

## POST /api/v1/groups/{groupId}/chats/{chatId}/preview

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/groups/{groupId}/chats/{chatId}/preview`

Prepare a group member's prompt without dispatching a provider request.

**PARAMS**
- `groupId` (path, required; string)
- `chatId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `characterId` (string, required)
  - `input` (string)
  - `type` (string)
  - `overrides` (object)
  - `nativeContext` (object)

**RETURN**
- `200`: Prepared prompt and warnings.
- `404`: Group

<a id="ep-post-api-v1-groups-groupid-chats-chatid-render"></a>

## POST /api/v1/groups/{groupId}/chats/{chatId}/render

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/groups/{groupId}/chats/{chatId}/render`

Read a group transcript page and its native display projections.

**PARAMS**
- `groupId` (path, required; string)
- `chatId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `limit` (integer)
  - `before` (integer)
  - `after` (integer)
  - `nativeContext` (object)

**RETURN**
- `200`: Raw page
- `400`: Invalid display context.
- `404`: Group chat not found.

<a id="ep-get-api-v1-groups-groupid-chats-chatid-sampling"></a>

## GET /api/v1/groups/{groupId}/chats/{chatId}/sampling

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/groups/{groupId}/chats/{chatId}/sampling`

Read group chat sampling overrides and revision.

**PARAMS**
- `groupId` (path, required; string)
- `chatId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Overrides and revision.
- `404`: Group or chat not found.

<a id="ep-put-api-v1-groups-groupid-chats-chatid-sampling"></a>

## PUT /api/v1/groups/{groupId}/chats/{chatId}/sampling

**METHOD**: `PUT`

**ENDPOINT**: `/api/v1/groups/{groupId}/chats/{chatId}/sampling`

Replace group chat sampling overrides with revision checking.

**PARAMS**
- `groupId` (path, required; string)
- `chatId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `expectedRevision` (string, required)
  - `overrides` (object, required)

**RETURN**
- `200`: Saved overrides and revision.
- `400`: Invalid request.
- `409`: Revision conflict or generation blocks editing.
- `422`: Invalid stored chat.

<a id="ep-post-api-v1-groups-groupid-chats-chatid-swipe"></a>

## POST /api/v1/groups/{groupId}/chats/{chatId}/swipe

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/groups/{groupId}/chats/{chatId}/swipe`

Select an assistant reply alternative.

**PARAMS**
- `groupId` (path, required; string)
- `chatId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `index` (integer, required)
  - `swipeId` (integer, required)
  - `expectedMessage` (object)

**RETURN**
- `200`: Selected reply alternative.
- `400`: Invalid message or alternative.
- `409`: Chat has an active or unresolved generation.
