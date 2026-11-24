# Global Concepts

## On this page

- [Base path](#base-path)
- [Authentication](#authentication)
- [Revisions](#revisions)
- [Paging](#paging)
- [Generation outcomes](#generation-outcomes)
- [Response formats](#response-formats)
- [Machine-readable contract](#machine-readable-contract)

## Base path

Versioned operations use `/api/v1`. The separate standard-host session helpers are documented at their literal paths in the endpoint list.

## Authentication

In companion mode send `Authorization: Bearer <capability>` with every request. In regular session mode send the authenticated session cookie; mutating requests also send the CSRF token required by the host. JSON request bodies use `Content-Type: application/json`. An endpoint may define additional headers.

## Revisions

Revision values are opaque. Send the exact value received on the read when an endpoint asks for `expectedRevision`. A 409 means the resource changed or the requested operation is no longer valid.

## Paging

Endpoints that return message pages use `limit`, `before`, and/or `after` as listed. Message `index` values identify stored rows; use the returned index when editing or selecting a swipe.

## Generation outcomes

Provider requests are not automatically replayed. A transport failure can leave the outcome unknown. Resolve it by `clientRequestId`, inspect the snapshot, and acknowledge only the inspected terminal sequence after local work has stopped.

## Response formats

Unless stated otherwise, responses are JSON. SSE endpoints return `text/event-stream`. File exports are returned as a JSON envelope containing `fileName`, `mimeType`, and `dataBase64`.

## Machine-readable contract

[openapi.yaml](../openapi.yaml) includes request schemas, limits, status codes, and security definitions.
