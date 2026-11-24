# Generations

## On this page

- [GET /api/v1/generations](#ep-get-api-v1-generations)
- [POST /api/v1/generations](#ep-post-api-v1-generations)
- [GET /api/v1/generations/{requestId}](#ep-get-api-v1-generations-requestid)
- [POST /api/v1/generations/{requestId}/acknowledge](#ep-post-api-v1-generations-requestid-acknowledge)
- [POST /api/v1/generations/{requestId}/cancel](#ep-post-api-v1-generations-requestid-cancel)
- [GET /api/v1/generations/{requestId}/events](#ep-get-api-v1-generations-requestid-events)
- [POST /api/v1/generations/{requestId}/tool-batches/{batchId}/{action}](#ep-post-api-v1-generations-requestid-tool-batches-batchid-action)
- [GET /api/v1/generations/by-client/{clientRequestId}](#ep-get-api-v1-generations-by-client-clientrequestid)
- [POST /api/v1/generations/by-client/{clientRequestId}/abandon](#ep-post-api-v1-generations-by-client-clientrequestid-abandon)
- [POST /api/v1/generations/preview](#ep-post-api-v1-generations-preview)

<a id="ep-get-api-v1-generations"></a>

## GET /api/v1/generations

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/generations`

Discover scoped active, uncertain and historical request identities without replay.

**PARAMS**
- `characterId` (query, required; string)
- `chatId` (query, required; string)
- `targetKind` (query; string, character | group)
- `limit` (query; integer)
- `before` (query; string)
- `unresolvedOnly` (query; boolean)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Page of matching generation records, including older records.
  - `application/json` response
    - `generations` (array of object, required)
    - `hasMore` (boolean, required)
    - `nextBefore` (string or null, required)
- `503`: Journal integrity or synchronization could not be verified.

<a id="ep-post-api-v1-generations"></a>

## POST /api/v1/generations

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/generations`

Start an idempotent generation.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json` (`GenerationInput` schema)
  - `characterId` (string, required)
  - `chatId` (string, required)
  - `clientRequestId` (string, required)
  - `type` (string)
  - `input` (string)
  - `tools` (array of object): OpenAI function definitions within 256 KiB. Requires enabled Chat Completion function calling and character normal/regenerate generation. Catalogs never authorize execution.
  - `stream` (boolean)
  - `nativeContext` (object): Optional device and UI facts used during preparation. Preview does not save variable changes; a generation can save them before provider completion. Arbitrary script injection is not accepted.
    - `input` (string): Current composer draft, including when requesting regenerate/continue.
    - `locale` (string): Valid BCP-47 device locale.
    - `timeZone` (string): Valid IANA device time-zone identifier.
    - `isMobile` (boolean)
    - `firstDisplayedMessageId` (integer): Zero-based visible transcript message, excluding the JSONL metadata header.
    - `lastGenerationType` (string): Previously observed generation type for preview; actual dispatch uses its accepted type.
  - `overrides` (object): Per-request sampling overrides. Never exposes credentials or base URLs.
    - `model` (string)
    - `temperature` (number)
    - `maxTokens` (integer)
    - `frequencyPenalty` (number)
    - `presencePenalty` (number)
    - `topP` (number)
    - `stop` (array of string)

**RETURN**
- `202`: Generation accepted.
  - `application/json` response (`GenerationAccepted` schema)
    - `requestId` (string, required)
    - `status` (string, required)
    - `seq` (integer, required)
    - `idempotent` (boolean, required)
    - `snapshotUrl` (string, required)
    - `eventUrl` (string, required)
    - `cancelUrl` (string, required)

<a id="ep-get-api-v1-generations-requestid"></a>

## GET /api/v1/generations/{requestId}

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/generations/{requestId}`

Poll the current generation snapshot after a disconnected SSE stream.

**PARAMS**
- `requestId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Current or restored snapshot; interrupted work is unknown and never replayed.
  - `application/json` response (`GenerationSnapshot` schema)
- `404`: Request is not owned by this authenticated user.
- `503`: Snapshot could not be verified.

<a id="ep-post-api-v1-generations-requestid-acknowledge"></a>

## POST /api/v1/generations/{requestId}/acknowledge

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/generations/{requestId}/acknowledge`

Confirm an inspected uncertain result after local processing has stopped.

**PARAMS**
- `requestId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `expectedSeq` (integer, required)

**RETURN**
- `200`: Acknowledged snapshot; the old request is never replayed.
  - `application/json` response (`GenerationSnapshot` schema)
- `409`: The state changed or local processing is still active.
- `503`: Acknowledgement could not be synchronized.

<a id="ep-post-api-v1-generations-requestid-cancel"></a>

## POST /api/v1/generations/{requestId}/cancel

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/generations/{requestId}/cancel`

Request cancellation; draining work remains cancelling and terminal races may be unknown.

**PARAMS**
- `requestId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `202`: Cancellation requested. Check the snapshot for the final result; the provider may still have completed the request.

<a id="ep-get-api-v1-generations-requestid-events"></a>

## GET /api/v1/generations/{requestId}/events

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/generations/{requestId}/events`

Subscribe to SSE events. Clients should not automatically replay a generation.

**PARAMS**
- `requestId` (path, required; string)
- `afterSeq` (query; integer)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: SSE event stream.
  - `text/event-stream` response

<a id="ep-post-api-v1-generations-requestid-tool-batches-batchid-action"></a>

## POST /api/v1/generations/{requestId}/tool-batches/{batchId}/{action}

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/generations/{requestId}/tool-batches/{batchId}/{action}`

Claim, decline or submit complete results for an inspected tool batch.

**PARAMS**
- `requestId` (path, required; string)
- `batchId` (path, required; string)
- `action` (path, required; string, claim | decline | results)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `expectedRevision` (string, required)
  - `executionId` (string)
  - `results` (array of object): Complete ordered result set within 1 MiB. Required for results action.
    - Each item:
      - `id` (string, required)
      - `result` (string, required)
      - `isError` (boolean, required)

**RETURN**
- `200`: Batch and idempotent status. Claims include dispatchAuthorized
- `400`: Invalid identity or incomplete
- `404`: Request
- `409`: Stale revision

<a id="ep-get-api-v1-generations-by-client-clientrequestid"></a>

## GET /api/v1/generations/by-client/{clientRequestId}

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/generations/by-client/{clientRequestId}`

Resolve unconfirmed acceptance through the permanent caller-key index.

**PARAMS**
- `clientRequestId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Existing canonical snapshot; no provider is contacted.
  - `application/json` response (`GenerationSnapshot` schema)
- `404`: No admission is visible at this lookup.
- `503`: Storage could not be verified; do not infer absence or replay.

<a id="ep-post-api-v1-generations-by-client-clientrequestid-abandon"></a>

## POST /api/v1/generations/by-client/{clientRequestId}/abandon

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/generations/by-client/{clientRequestId}/abandon`

Cancel the admitted task or permanently reserve a not-yet-admitted key against late execution.

**PARAMS**
- `clientRequestId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `characterId` (string, required)
  - `chatId` (string, required)
  - `targetKind` (string)

**RETURN**
- `200`: Snapshot of the original task or a no-dispatch cancelled tombstone.
  - `application/json` response (`GenerationSnapshot` schema)
- `409`: Caller identity belongs to a different chat.
- `503`: Reservation could not be made durable.

<a id="ep-post-api-v1-generations-preview"></a>

## POST /api/v1/generations/preview

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/generations/preview`

Assemble a prompt without contacting a model provider.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json` (`GenerationInput` schema)
  - `characterId` (string, required)
  - `chatId` (string, required)
  - `clientRequestId` (string, required)
  - `type` (string)
  - `input` (string)
  - `tools` (array of object): OpenAI function definitions within 256 KiB. Requires enabled Chat Completion function calling and character normal/regenerate generation. Catalogs never authorize execution.
  - `stream` (boolean)
  - `nativeContext` (object): Optional device and UI facts used during preparation. Preview does not save variable changes; a generation can save them before provider completion. Arbitrary script injection is not accepted.
    - `input` (string): Current composer draft, including when requesting regenerate/continue.
    - `locale` (string): Valid BCP-47 device locale.
    - `timeZone` (string): Valid IANA device time-zone identifier.
    - `isMobile` (boolean)
    - `firstDisplayedMessageId` (integer): Zero-based visible transcript message, excluding the JSONL metadata header.
    - `lastGenerationType` (string): Previously observed generation type for preview; actual dispatch uses its accepted type.
  - `overrides` (object): Per-request sampling overrides. Never exposes credentials or base URLs.
    - `model` (string)
    - `temperature` (number)
    - `maxTokens` (integer)
    - `frequencyPenalty` (number)
    - `presencePenalty` (number)
    - `topP` (number)
    - `stop` (array of string)

**RETURN**
- `200`: Prompt messages or a text-completion prompt string, segments, warnings and provider request. Chat Completion profiles populate messages. Text-completion profiles populate prompt.
