# Tutorial: Preview and send a generation

## On this page

- [Steps](#steps)
- [Example request](#example-request)
- [Send and observe](#send-and-observe)

## Steps
This example shows the request sequence. Replace the IDs with values from your character/chat catalog and retain the same `clientRequestId` if you need to resolve a lost response.

1. Read capabilities and select an advertised provider.
2. Read a character and one of its chats, or create a chat.
3. Preview the prompt with `POST /api/v1/generations/preview` if the client needs a confirmation step. Preview does not contact a model.
4. Submit `POST /api/v1/generations` with `characterId`, `chatId`, and a new `clientRequestId`.
5. Follow `eventUrl`. On disconnect, poll `snapshotUrl`; never resubmit automatically.
6. If the result is uncertain, inspect the snapshot and acknowledge its exact sequence after the task is drained.

## Example request

The provider and prompt options depend on the advertised capabilities.

```json
{
  "characterId": "example-character",
  "chatId": "example-chat",
  "clientRequestId": "client-generated-unique-id",
  "type": "normal",
  "input": "Hello!",
  "stream": true
}
```

## Send and observe

Save the body as `generation.json` and send it with the capability:

```sh
curl http://127.0.0.1:8000/api/v1/generations \
  -H "Authorization: Bearer <capability>" \
  -H "Content-Type: application/json" \
  --data @generation.json
```

The accepted response contains a `requestId`, `snapshotUrl`, and `eventUrl`.
Open the event URL as an SSE stream. If the connection closes, fetch the
snapshot URL to find the current state and any partial output. If the POST
response itself was lost, call `GET /api/v1/generations/by-client/{clientRequestId}`
with the same ID before doing anything else. A not-found lookup is not, by
itself, permission to reuse the ID; explicitly abandon it if you have ruled out
the delayed request.

The exact accepted fields and response shapes are in the [OpenAPI schema](../openapi.yaml) and the [generation endpoint reference](../reference/generations.md).
