# Prompts and presets

## On this page

- [PUT /api/v1/instruct-mode](#ep-put-api-v1-instruct-mode)
- [GET /api/v1/preset-settings/{kind}](#ep-get-api-v1-preset-settings-kind)
- [GET /api/v1/presets/{kind}](#ep-get-api-v1-presets-kind)
- [GET /api/v1/presets/{kind}/{name}](#ep-get-api-v1-presets-kind-name)
- [PUT /api/v1/presets/{kind}/{name}](#ep-put-api-v1-presets-kind-name)
- [DELETE /api/v1/presets/{kind}/{name}](#ep-delete-api-v1-presets-kind-name)
- [POST /api/v1/presets/{kind}/{name}/activate](#ep-post-api-v1-presets-kind-name-activate)
- [GET /api/v1/presets/{kind}/{name}/export](#ep-get-api-v1-presets-kind-name-export)
- [GET /api/v1/prompt-manager](#ep-get-api-v1-prompt-manager)
- [PUT /api/v1/prompt-manager](#ep-put-api-v1-prompt-manager)

<a id="ep-put-api-v1-instruct-mode"></a>

## PUT /api/v1/instruct-mode

**METHOD**: `PUT`

**ENDPOINT**: `/api/v1/instruct-mode`

Set text-completion Instruct formatting against the active settings revision.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `expectedRevision` (string, required)
  - `enabled` (boolean, required)

**RETURN**
- `200`: Updated active Instruct preset document.
- `400`: Invalid input.
- `409`: Active Instruct settings changed.

<a id="ep-get-api-v1-preset-settings-kind"></a>

## GET /api/v1/preset-settings/{kind}

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/preset-settings/{kind}`

Snapshot active settings with preset field names and no credentials.

**PARAMS**
- `kind` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Active kind

<a id="ep-get-api-v1-presets-kind"></a>

## GET /api/v1/presets/{kind}

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/presets/{kind}`

List bundled/user templates, file revisions and the active configuration revision.

**PARAMS**
- `kind` (path, required; string, chat-completion | context | instruct | sysprompt)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Preset catalog with activeName

<a id="ep-get-api-v1-presets-kind-name"></a>

## GET /api/v1/presets/{kind}/{name}

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/presets/{kind}/{name}`

Inspect a preset, its revision and connection changes before selection.

**PARAMS**
- `kind` (path, required; string)
- `name` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Preset document with origin
- `404`: Preset not found.

<a id="ep-put-api-v1-presets-kind-name"></a>

## PUT /api/v1/presets/{kind}/{name}

**METHOD**: `PUT`

**ENDPOINT**: `/api/v1/presets/{kind}/{name}`

Create a named preset or replace the inspected revision (maximum 1 MiB JSON).

**PARAMS**
- `kind` (path, required; string)
- `name` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `preset` (object, required)
  - `expectedRevision` (string)

**RETURN**
- `200`: Saved document with new revision.
- `400`: Invalid
- `409`: Existing name or stale revision.

<a id="ep-delete-api-v1-presets-kind-name"></a>

## DELETE /api/v1/presets/{kind}/{name}

**METHOD**: `DELETE`

**ENDPOINT**: `/api/v1/presets/{kind}/{name}`

Delete an inspected inactive user preset, revealing any bundled original.

**PARAMS**
- `kind` (path, required; string)
- `name` (path, required; string)
- `expectedRevision` (query, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: User preset removed.
- `409`: Revision conflict

<a id="ep-post-api-v1-presets-kind-name-activate"></a>

## POST /api/v1/presets/{kind}/{name}/activate

**METHOD**: `POST`

**ENDPOINT**: `/api/v1/presets/{kind}/{name}/activate`

Select the inspected preset with active-configuration conflict checking.

**PARAMS**
- `kind` (path, required; string)
- `name` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `expectedRevision` (string, required)
  - `expectedActiveRevision` (string, required)
  - `allowConnectionChanges` (boolean)

**RETURN**
- `200`: Updated preset catalog.
- `409`: Revision conflict or explicit connection-change confirmation required.
- `422`: Unsupported provider source.

<a id="ep-get-api-v1-presets-kind-name-export"></a>

## GET /api/v1/presets/{kind}/{name}/export

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/presets/{kind}/{name}/export`

Export portable JSON without credentials.

**PARAMS**
- `kind` (path, required; string)
- `name` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: File envelope with fileName

<a id="ep-get-api-v1-prompt-manager"></a>

## GET /api/v1/prompt-manager

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/prompt-manager`

Read the active global Chat Completion prompt configuration and revision.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Scoped configuration, with other prompt/order fields preserved.
  - `application/json` response
    - `revision` (string, required)
    - `prompts` (array of object, required)
    - `order` (array of object, required)

<a id="ep-put-api-v1-prompt-manager"></a>

## PUT /api/v1/prompt-manager

**METHOD**: `PUT`

**ENDPOINT**: `/api/v1/prompt-manager`

Replace the inspected active prompt configuration without changing provider settings.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `expectedRevision` (string, required)
  - `prompts` (array of object, required)
  - `order` (array of object, required)

**RETURN**
- `200`: Saved configuration with new revision.
- `400`: Malformed or oversized prompt configuration.
- `409`: Configuration changed; reload before saving.
