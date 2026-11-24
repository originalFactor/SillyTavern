# Extensions

## On this page

- [GET /api/v1/extensions](#ep-get-api-v1-extensions)
- [GET /api/v1/extensions/{extensionId}/settings](#ep-get-api-v1-extensions-extensionid-settings)
- [PATCH /api/v1/extensions/{extensionId}/settings](#ep-patch-api-v1-extensions-extensionid-settings)
- [GET /api/v1/extensions/{extensionId}/shell](#ep-get-api-v1-extensions-extensionid-shell)

<a id="ep-get-api-v1-extensions"></a>

## GET /api/v1/extensions

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/extensions`

List UI/server extensions and their API v1 runtime classification.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- See the HTTP status and response schema in OpenAPI.

<a id="ep-get-api-v1-extensions-extensionid-settings"></a>

## GET /api/v1/extensions/{extensionId}/settings

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/extensions/{extensionId}/settings`

Read one extension's settings namespace.

**PARAMS**
- `extensionId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Extension settings.

<a id="ep-patch-api-v1-extensions-extensionid-settings"></a>

## PATCH /api/v1/extensions/{extensionId}/settings

**METHOD**: `PATCH`

**ENDPOINT**: `/api/v1/extensions/{extensionId}/settings`

Merge-patch one extension's settings namespace (requires headlessPlugins).

**PARAMS**
- `extensionId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`

**RETURN**
- `200`: Updated extension settings.
- `403`: Headless plugins are disabled.

<a id="ep-get-api-v1-extensions-extensionid-shell"></a>

## GET /api/v1/extensions/{extensionId}/shell

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/extensions/{extensionId}/shell`

Open a same-origin compatibility WebView shell with a real context bridge.

**PARAMS**
- `extensionId` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: HTML shell.
  - `text/html` response
