# Provider credentials

## On this page

- [GET /api/v1/provider-credentials](#ep-get-api-v1-provider-credentials)
- [POST /api/v1/provider-models](#ep-post-api-v1-provider-models)
- [GET /api/v1/provider-status](#ep-get-api-v1-provider-status)
- [POST /api/v1/provider-status/check](#ep-post-api-v1-provider-status-check)
- [PUT /api/v1/provider-credentials](#ep-put-api-v1-provider-credentials)
- [DELETE /api/v1/provider-credentials/{provider}](#ep-delete-api-v1-provider-credentials-provider)

<a id="ep-get-api-v1-provider-credentials"></a>

## GET /api/v1/provider-credentials

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/provider-credentials`

Read whether OpenAI and custom endpoint credentials are configured; never returns secret values.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Credential presence flags.

<a id="ep-post-api-v1-provider-models"></a>

## POST /api/v1/provider-models

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/provider-models`

Read model IDs from the supplied OpenAI-compatible base URL's `/models` endpoint. The backend uses the saved custom provider key and returns model IDs, display names, and context/output limits when the endpoint supplies them.

**BODY**
- Required `application/json`
  - `baseUrl` (string, required): Absolute HTTP(S) base URL without credentials, query, or fragment.

**BEHAVIOR**
- Requires a saved custom provider credential.
- Appends `/models` to the base URL and performs one bounded GET without following redirects.
- The request times out after 10 seconds; the response is limited to 2 MiB and 2000 model entries.
- Provider credentials and arbitrary response fields are never returned.

**RETURN**
- `200`: `{ "models": [{ "id": "...", "name": "..." }] }`.
- `409`: Custom provider credential is not configured.
- `422`: Invalid base URL.
- `502`: The provider returned an error or malformed model list.

<a id="ep-get-api-v1-provider-status"></a>

## GET /api/v1/provider-status

Authenticated observation, advertised by `resources.providerStatus`, with
`Cache-Control: no-store`. This GET never contacts a provider. Returns exactly:

```json
{"onlineStatus":"no_connection","state":"unchecked","checkedAt":null}
```

`state` is `unchecked`, `checking`, `valid` or `failed`. Only `valid` maps to
`onlineStatus: "Valid"`. Completed checks contain `checkedAt` in Unix epoch
milliseconds; unchecked/checking states contain `null`. A valid result means
access to a bounded model catalog, not successful generation or model support.
Key presence, unrelated `/provider-models` discovery and completed generations
never establish this status.

Observations are private to the authenticated user's directory and current
process, bound internally to provider settings and the matching vault key. They
expire after five minutes and reset on process restart, settings PATCH or
credential writes. Direct/preset configuration changes are detected on subsequent
reads and before accepting a check result. The bounded cache retains at most 128
user observations/checks and may evict idle entries. An absent/expired/invalidated
entry returns unchecked. No URLs, credentials, private fingerprints, arbitrary
provider fields or model rows are returned or persisted.

<a id="ep-post-api-v1-provider-status-check"></a>

## POST /api/v1/provider-status/check

Explicit action with body `{}`. Uses saved `main_api: "openai"`, source
`openai`/`custom`, the corresponding saved base URL and matching vault key.
Caller-supplied URLs, source selectors, keys and headers are rejected. Sends one
GET to `/models`, bounded to ten seconds, 2 MiB and 2000 valid model entries,
without following redirects or retrying. It performs no generation/tool call.

While pending, observation is checking/no_connection. Success returns the same
status document with valid/Valid. Provider HTTP, malformed/interrupted/oversized
or timed-out responses return `502` and leave failed/no_connection; error details
are credential-redacted. Invalid configuration/source returns `422`; missing keys,
concurrent checks, exhausted capacity or configuration changes during a check
return `409`. Invalid nonempty bodies return `400`. A stale completion cannot
replace a newer observation or restore a discarded success. Responses, including
failures, use `Cache-Control: no-store`.

The client exposes this action as **Check provider connection** in API settings,
disabled while local model/key drafts are unsaved. Extension frames only receive
the named read-only `provider.status` observation; they cannot request a check.

<a id="ep-put-api-v1-provider-credentials"></a>

## PUT /api/v1/provider-credentials

**METHOD**: `PUT`

**ENDPOINT**: `/api/v1/provider-credentials`

Store one OpenAI or OpenAI-compatible API key in the server-side secrets file. Use `provider: "custom"` for a custom endpoint configured with `oai_settings.chat_completion_source: "custom"` and `oai_settings.custom_url`.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `provider` (string, required): openai or custom
  - `apiKey` (string, required)

**RETURN**
- `200`: Credential stored; response contains no secret value.

<a id="ep-delete-api-v1-provider-credentials-provider"></a>

## DELETE /api/v1/provider-credentials/{provider}

**METHOD**: `DELETE`

**ENDPOINT**: `/api/v1/provider-credentials/{provider}`

Delete all stored keys for the selected supported provider.

**PARAMS**
- `provider` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Credential deleted.
