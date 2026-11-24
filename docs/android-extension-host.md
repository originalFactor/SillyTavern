# Android extension host

This document describes Android work that is still needed to host extensions
in Messenger. It is a design and verification guide, not a claim that the
extension WebView is already implemented. Desktop is outside its scope.

## Contents

- [Companion connection](#companion-connection)
- [WebView design](#webview-design)
- [Compatibility shown to users](#compatibility-shown-to-users)
- [Verification before release](#verification-before-release)

## Companion connection

The companion provides authenticated `GET /compat/extensions` and `/compat/ws`
endpoints. The native app keeps the bearer capability in memory and authenticates
the WebSocket connection with it. Extension JavaScript must never receive the
capability.

The client sends version 1 RPC requests with a unique `id`, increasing `seq`,
HTTP `method`, versioned API `path`, optional JSON `body`, and bounded
`deadlineMs`. It matches each response by both ID and sequence number. Frames
are limited to 1 MiB and deadlines to 30 seconds. Credential routes are not
available. There are no automatic retries: a timeout, socket loss, or process
restart can leave a mutation's result unknown.

The companion-side probe, `scripts/compat-min-client.mjs`, demonstrates this
boundary. It accepts the capability in its constructor; its plugin-facing
`call()` method accepts only an API method, path, body, and deadline. It does
not return or log the capability.

## WebView design

1. Add a dedicated Android extension screen. Load a Messenger-owned shell from
   an app-owned HTTPS asset origin, with each extension under its own asset
   path. Do not load the archived upstream `index.html`.
2. Package extension assets separately from the companion bundle. Resolve
   manifest paths beneath the selected extension directory. Reject symlinks,
   path traversal, unknown URL schemes, and undeclared files.
3. Allow navigation only to the shell and the selected extension's packaged
   assets. Block popups, downloads, file/content access, mixed content, service
   workers, arbitrary network requests, and unapproved remote scripts. Any
   remote script activation must be an explicit user choice for that extension
   or preset.
4. Run a dedicated dispatcher thread or coroutine for the authenticated
   WebSocket. It owns request IDs, sequence numbers, response matching,
   deadlines, disconnect errors, and lifecycle events. Never persist the
   capability or expose it in JavaScript messages.
5. If an extension needs synchronous-looking calls, use a narrow JavaScript
   bridge that waits only on the WebView bridge thread. Keep the dispatcher
   independent so it can receive the response and wake the caller. Expose
   named host operations; do not expose arbitrary Android objects or
   reflection. Never block the UI thread or WebSocket dispatcher.
6. Keep DOM, CSS, event dispatch, and extension layout inside the WebView.
   Translate only documented host operations and events across the bridge.
   Return an explicit diagnostic naming the extension and unsupported API;
   do not silently return an empty value.
7. When the user navigates away, changes extensions, or destroys the WebView or
   activity, invalidate pending bridge calls and close the host session. Never
   replay pending mutations after reconnect.

## Compatibility shown to users

The extension settings screen should show each manifest's adapter status,
required and supported capabilities, and diagnostics from
`GET /compat/extensions`. Built-in adapters should list only methods covered
by compatibility tests. Extensions without adapter metadata can be shown as
best-effort, with missing-method warnings before activation.

Preset activation may authorize that preset's SPreset regex rules. Importing or
viewing a preset does not grant execution authority.

## Verification before release

- Check the local asset origin and per-extension path isolation. Confirm that
  external navigation, popups, file URLs, and undeclared remote scripts are
  rejected.
- Exercise bridge timeout and disconnect behavior while confirming the
  independent dispatcher still receives RPC results.
- Check event delivery, increasing sequence numbers, payload limits, duplicate
  IDs, unsupported methods, and the absence of mutation replay.
- Confirm the capability never appears in JavaScript globals, the DOM, URLs,
  logs, crash reports, or plugin-facing RPC results.
- Build and run on an Android emulator with the standalone companion. Confirm
  that API and WebSocket connections stay on loopback and require the
  capability.
- Try the reference preset, SPreset rules, Tavern Helper menu, and each bundled
  extension package. Keep unsupported methods explicit and actionable.
