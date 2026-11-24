# World Info

## On this page

- [GET /api/v1/world-info](#ep-get-api-v1-world-info)
- [GET /api/v1/world-info-settings](#ep-get-api-v1-world-info-settings)
- [PUT /api/v1/world-info-settings](#ep-put-api-v1-world-info-settings)
- [GET /api/v1/world-info/{name}](#ep-get-api-v1-world-info-name)
- [PUT /api/v1/world-info/{name}](#ep-put-api-v1-world-info-name)
- [DELETE /api/v1/world-info/{name}](#ep-delete-api-v1-world-info-name)
- [GET /api/v1/world-info/{name}/export](#ep-get-api-v1-world-info-name-export)

<a id="ep-get-api-v1-world-info"></a>

## GET /api/v1/world-info

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/world-info`

List bounded native World Info book names and unsafe-file warnings.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Object with books (name and bytes) and warnings arrays. Catalog does not parse book contents.
- `422`: Storage unavailable or more than 512 books.

<a id="ep-get-api-v1-world-info-settings"></a>

## GET /api/v1/world-info-settings

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/world-info-settings`

Read World Info settings and their independent revision, excluding provider settings.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Object with settings and revision.

<a id="ep-put-api-v1-world-info-settings"></a>

## PUT /api/v1/world-info-settings

**METHOD**: `PUT`

**ENDPOINT**: `/api/v1/world-info-settings`

Replace only World Info settings with revision checking and selected-book validation.

**PARAMS**
- None.

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `expectedRevision` (string, required)
  - `settings` (object, required): At most 1 MiB. world_info.globalSelect is a name array; world_info.charLore records contain character ID name and extraBooks array. Unknown fields are preserved as supplied.

**RETURN**
- `200`: Saved settings and revision. Unrelated latest settings are merged.
- `400`: Invalid scan controls or duplicate/malformed bindings.
- `404`: Selected book not found.
- `409`: Settings revision changed.

<a id="ep-get-api-v1-world-info-name"></a>

## GET /api/v1/world-info/{name}

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/world-info/{name}`

Read a native JSON book and its revision token (4 MiB maximum).

**PARAMS**
- `name` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Object with name
- `404`: Book not found.
- `422`: Unsafe

<a id="ep-put-api-v1-world-info-name"></a>

## PUT /api/v1/world-info/{name}

**METHOD**: `PUT`

**ENDPOINT**: `/api/v1/world-info/{name}`

Create or replace a complete native book, preserving supplied opaque fields.

**PARAMS**
- `name` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- Required `application/json`
  - `expectedRevision` (string): Omit or null for create only; current digest required for replacement.
  - `book` (object, required): Native SillyTavern object with entries object; maximum 4 MiB and 20000 entries.

**RETURN**
- `200`: Saved name
- `400`: Invalid native book or unsafe name.
- `409`: Book exists or inspected revision changed. Draft was not applied.

<a id="ep-delete-api-v1-world-info-name"></a>

## DELETE /api/v1/world-info/{name}

**METHOD**: `DELETE`

**ENDPOINT**: `/api/v1/world-info/{name}`

Delete only an unbound book using the inspected revision.

**PARAMS**
- `name` (path, required; string)
- `expectedRevision` (query, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: Deleted name.
- `409`: Book changed or remains referenced.
- `422`: Reference inventory cannot be inspected safely.

<a id="ep-get-api-v1-world-info-name-export"></a>

## GET /api/v1/world-info/{name}/export

**METHOD**: `GET`

**ENDPOINT**: `/api/v1/world-info/{name}/export`

Export complete native JSON as a bounded base64 file envelope.

**PARAMS**
- `name` (path, required; string)

**HEADERS**
- No endpoint-specific headers. Apply the [global authentication and content-type rules](../chapters/global-concepts.md).

**BODY**
- None.

**RETURN**
- `200`: fileName
