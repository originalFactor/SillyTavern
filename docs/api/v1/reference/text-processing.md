# Text processing

## On this page

- [GET /api/v1/regex-settings](#ep-get-api-v1-regex-settings)
- [PUT /api/v1/regex-settings](#ep-put-api-v1-regex-settings)

<a id="ep-get-api-v1-regex-settings"></a>

## GET /api/v1/regex-settings

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/regex-settings`

Read independently revisioned global regex scripts and explicit scope grants.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Object with revision and settings (enabled
- `422`: Stored regex/permission state is malformed or oversized. Nothing is truncated.

<a id="ep-put-api-v1-regex-settings"></a>

## PUT /api/v1/regex-settings

**METHOD**: `PUT`

**ENDPOINT**: `/api/v1/regex-settings`

Save global regex and permission lists without implicitly granting imported scopes.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `expectedRevision` (string, required)
  - `settings` (object, required)
    - `enabled` (boolean, required)
    - `scripts` (array of object, required)
    - `characterAllowed` (array of string, required): Exact avatar filenames. Grants also apply to future edits of those cards.
    - `presetAllowed` (object, required): API ID to preset-name arrays. Grants also apply to future edits.
  - `confirmScopeChanges` (boolean): Separate explicit confirmation required for added scopes or re-enabling scoped regex. Never inferred from script/card/preset JSON.

**RETURN**
- `200`: Saved settings and revision. Latest unrelated provider
- `400`: Invalid script fields
- `409`: Revision conflict or explicit scope confirmation required. Draft was not applied.
