# Provider credentials

## On this page

- [GET /api/v1/provider-credentials](#ep-get-api-v1-provider-credentials)
- [PUT /api/v1/provider-credentials](#ep-put-api-v1-provider-credentials)
- [DELETE /api/v1/provider-credentials/{provider}](#ep-delete-api-v1-provider-credentials-provider)

<a id="ep-get-api-v1-provider-credentials"></a>

## GET /api/v1/provider-credentials

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/provider-credentials`

Read whether the OpenAI credential is configured; never returns secret values.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Credential presence flags.

<a id="ep-put-api-v1-provider-credentials"></a>

## PUT /api/v1/provider-credentials

**METHOD**: `PUT`

**ENDPOINT**: `/api/v1/provider-credentials`

Store one OpenAI or OpenAI-compatible API key in the server-side secrets file.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `provider` (string, required): openai
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
