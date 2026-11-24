# Discovery

## On this page

- [GET /api/v1/capabilities](#ep-get-api-v1-capabilities)
- [GET /api/v1/companion/health](#ep-get-api-v1-companion-health)

<a id="ep-get-api-v1-capabilities"></a>

## GET /api/v1/capabilities

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/capabilities`

List supported API v1 capabilities.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Capability document.
  - `application/json` response

<a id="ep-get-api-v1-companion-health"></a>

## GET /api/v1/companion/health

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/companion/health`

Readiness probe for the loopback-only native companion entry.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Companion is ready.
  - `application/json` response
    - `ok` (boolean)
    - `service` (string)
    - `version` (integer)
    - `headless` (boolean)
- `401`: Missing or invalid capability.
