# Guide

## On this page

- [Discover what the server supports](#discover-what-the-server-supports)
- [Read and edit chat data](#read-and-edit-chat-data)
- [Submit generations safely](#submit-generations-safely)
- [Handle errors](#handle-errors)
- [Keep secrets and optional features safe](#keep-secrets-and-optional-features-safe)

### Discover what the server supports

Start with `GET /api/v1/capabilities`. Capability flags describe behavior available from this server. A missing or false capability means the client should not offer that behavior. A supported capability does not guarantee that a provider is configured or reachable.

### Read and edit chat data

Character and chat IDs are stable identifiers based on their saved filenames. Chat messages are returned as indexed records in SillyTavern’s JSONL format. Use paging parameters to load a window of messages. Before replacing a character, group, preset, or settings document, retain its returned revision and send that revision with the update. A stale revision returns a conflict; read again and let the user resolve the change.

### Submit generations safely

Give every generation a caller-created `clientRequestId` and save it before sending the request. If the response is lost, look up that ID; do not submit a second generation. Watch the returned event stream, then poll its snapshot after a disconnect. A generation that may have reached a provider can finish as unknown. Inspect and acknowledge an uncertain result before starting conflicting work.

A successful generation commits its user and assistant messages together. Failed or cancelled work does not leave a partial chat turn. Regenerate keeps the prior reply as a swipe; continue updates the selected reply. Quiet generation returns an observation without adding chat rows.

### Handle errors

Errors use a JSON `error` object with a code, message, retryable flag, and request ID. Common statuses include 400 (invalid input), 401 (authentication), 404 (missing resource), 409 (revision or lifecycle conflict), and 422 (stored data cannot be safely read). Do not retry a generation just because the client did not receive its response; resolve it by caller ID first.

### Keep secrets and optional features safe

Credential reads report whether a key is present; they never return its value. Settings and preview results redact credentials. A true feature flag means the described slice is implemented; it does not promise complete SillyTavern parity. Consult capabilities before showing optional features.
