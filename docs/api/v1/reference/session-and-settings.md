# Session and settings

## On this page

- [GET /api/v1/session](#ep-get-api-v1-session)
- [GET /api/v1/settings](#ep-get-api-v1-settings)
- [PATCH /api/v1/settings](#ep-patch-api-v1-settings)
- [GET /csrf-token](#ep-get-csrf-token)

<a id="ep-get-api-v1-session"></a>

## GET /api/v1/session

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/session`

Describe the authenticated user session.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Session document.

Returns `handle`, Persona display name `userName`, `authenticated:true`,
`csrfTokenUrl`, server multi-account switch `accountsEnabled`, and the authenticated
profile's boolean `admin` flag. The response is `Cache-Control: no-store` and
contains no password, salt, token, or full user profile. These fields describe
identity; each endpoint still independently enforces its authorization policy.
In particular, disabling multi-account mode does not grant package-management
access to a non-admin profile.

<a id="ep-get-api-v1-settings"></a>

## GET /api/v1/settings

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/settings`

Read raw and typed user settings.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- See the HTTP status and response schema in OpenAPI.

<a id="ep-patch-api-v1-settings"></a>

## PATCH /api/v1/settings

**METHOD**: `PATCH`

**ENDPOINT**: `/api/v1/settings`

Apply an RFC 7386 JSON Merge Patch to user settings.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/merge-patch+json`
- Required `application/json`

**RETURN**
- `200`: Updated raw settings.

<a id="ep-get-csrf-token"></a>

## GET /csrf-token

**METHOD**: `GET`

**ENDPOINT**: `/csrf-token`

Obtain the CSRF token for the current cookie session.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: CSRF token.
