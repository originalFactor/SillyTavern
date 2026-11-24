# Macros

## On this page

- [GET /api/v1/macro-variables/global](#ep-get-api-v1-macro-variables-global)
- [PUT /api/v1/macro-variables/global](#ep-put-api-v1-macro-variables-global)

<a id="ep-get-api-v1-macro-variables-global"></a>

## GET /api/v1/macro-variables/global

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/macro-variables/global`

Read global variables and the saved macro-engine choice.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Scoped variable document; never includes provider settings or vault credentials.
  - `application/json` response (`MacroVariableState` schema)
    - `revision` (string, required): Revision token for the inspected document.
    - `variables` (object, required): Complete JSON variable object, limited to 7 MiB.
    - `experimental` (boolean): Present only in global state; true selects the alternate macro engine.
- `422`: Stored state is invalid or exceeds the 7 MiB native document limit; no truncation.

<a id="ep-put-api-v1-macro-variables-global"></a>

## PUT /api/v1/macro-variables/global

**METHOD**: `PUT`

**ENDPOINT**: `/api/v1/macro-variables/global`

Replace global variables and engine choice with revision checking.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json` (`GlobalMacroVariableEdit` schema)
  - `expectedRevision` (string, required)
  - `variables` (object, required)
  - `experimental` (boolean, required)

**RETURN**
- `200`: Saved document with its new revision.
  - `application/json` response (`MacroVariableState` schema)
    - `revision` (string, required): Revision token for the inspected document.
    - `variables` (object, required): Complete JSON variable object, limited to 7 MiB.
    - `experimental` (boolean): Present only in global state; true selects the alternate macro engine.
- `409`: Variables or engine changed; explicitly reload before another save.
- `422`: Stored state is invalid or the variable document exceeds its limit.
