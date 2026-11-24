# Extension compatibility

The supported interface is the versioned `/api/v1` API. Extension adapters are
optional and do not change that contract. They provide different levels of
compatibility; none turns this headless server into the SillyTavern browser app.

## Contents

- [Server plugins](#server-plugins)
- [Headless generation extensions](#headless-generation-extensions)
- [Virtual DOM extensions](#virtual-dom-extensions)
- [Optional synchronous RPC design](#optional-synchronous-rpc-design)
- [Capability reports](#capability-reports)
- [Messenger WebSocket RPC](#messenger-websocket-rpc)
- [What is not provided](#what-is-not-provided)
- [Reference preset assessment](#reference-preset-assessment)

## Server plugins

When `enableServerPlugins: true` is set in `config.yaml`, plugins in
`<dataRoot>/plugins` can export the usual `info` metadata and `init(router)`
function. Their routes are mounted at `/api/plugins/<id>` and are protected by
the companion bearer capability. A plugin's `exit` hook runs during orderly
shutdown.

Server plugins are trusted Node.js code in the server process. They can add
arbitrary Express middleware and routes, so install only plugins you trust.
One plugin failing to load is logged without stopping the others. The
companion does not serve plugin static files.

## Headless generation extensions

An extension can declare `runtime: "headless"`, an ESM `entry`, and named
generation hooks in `manifest.json`. Enable these hooks with
`api.v1.headlessPlugins: true`. Hooks receive structured context in a worker;
credential-shaped fields are removed. They can adjust prompt data and return
bounded events, settings changes, and prompt insertions.

This adapter has no browser globals, arbitrary network access, direct file
writes, or ability to dispatch generations. It is separate from server plugins.

## Virtual DOM extensions

`src/headless/virtual-dom.js` provides an isolated `window`, `document`, and
jQuery instance backed by LinkeDOM. Extensions can create and change DOM trees,
use selectors and attributes, and dispatch DOM events. A host can collect
output with `emit()` as an HTML/text fragment. The adapter does not render a
page or calculate CSS layout.

For local extensions, authenticated `POST /compat/extensions/{id}/render`
loads a manifest-declared `virtual-dom` ESM entry in a bounded worker and calls
its `init(host)` export. The response contains a fragment as JSON. Input HTML
is limited to 256 KiB and serialized output to 1 MiB. The receiving client is
responsible for presenting returned HTML safely.

The adapter does not simulate computed styles, animation frames, storage,
dialogs, navigation, or browser networking. Calls to unsupported browser APIs
raise an `Unsupported browser API` error and appear in `diagnostics`.

### Optional synchronous RPC design

Some plugins expect a function to return immediately even when it needs host
data. Such calls require two independent workers: a plugin worker that can wait,
and a dispatcher that owns the WebSocket and receives replies. Blocking the
socket's own event loop would prevent it from processing the reply and cause a
deadlock.

Keep ordinary DOM operations in a local virtual DOM, then send batched tree
changes and user events to the host. Use bounded, deadline-limited RPC only for
operations that need host state. Layout queries can use recent measurements;
batch changes before requesting new measurements. Sequence numbers, payload
limits, cancellation, and explicit timeout errors are essential. This design
can support selected immediate-call APIs, but it does not provide a full
browser runtime. The current endpoint does not implement this bridge.

## Capability reports

Manifests may declare `runtime` as `headless`, `server-plugin`, or
`virtual-dom`, and list requirements such as `headless`, `server-plugin`, and
`virtual-dom` in `capabilities`. Authenticated `GET /compat/extensions` reports
manifests, adapter support, requirements, and diagnostics. Missing adapter tags
are treated as best-effort support; unknown requirements are reported as
degraded. A listed capability means the adapter exists, not that every API used
by an extension is implemented.

## Messenger WebSocket RPC

`/compat/ws` is a loopback-only WebSocket for the native Messenger host. The
host authenticates the HTTP upgrade with the companion capability; extension
JavaScript never receives that capability. Browser-origin upgrades are
rejected.

Version 1 messages are JSON objects:

```json
{"type":"request","id":"caller-id","seq":1,"method":"GET","path":"/characters","deadlineMs":10000}
{"type":"result","id":"caller-id","seq":1,"ok":true,"status":200,"body":{}}
{"type":"host-event","event":"connected","version":1,"maxPayloadBytes":1048576}
```

Requests run in sequence order and must have unique IDs. Frames are limited to
1 MiB and deadlines to 30 seconds. Only versioned API paths on the compatibility
allowlist are available; credential routes are excluded. Timeouts and
disconnects can leave a mutation's result unknown. The transport never retries
requests, so reconnect and recovery decisions belong to the native caller.

## What is not provided

There is no SPA, static frontend hosting, pixel rendering, CSS layout engine,
browser storage, service worker, browser WebSocket shell, or implicit browser
API emulation. Use `/api/v1` or one of the adapters described above.

## Reference preset assessment

The `Meowssiah-2.1.7-censored.json` sample contains more than prompt data: 47
prompt rows, two embedded Tavern Helper scripts, SPreset settings and
transformations, custom `catgodml` menu markers, and a scheduled task that loads
a remote script. Its global prompt order also names nine prompts that are not
present in the preset. The preset API preserves unresolved order entries,
reports warnings, and skips missing prompts during assembly. It cannot restore
missing prompt content.

The public [Tavern Helper source](https://github.com/N0VI028/JS-Slash-Runner)
shows an iframe-based script runtime with a broad host API. Its own project
warns that imported scripts can read sensitive data, change settings, and send
requests. It is licensed under PolyForm Noncommercial; this repository uses it
for interface analysis and does not copy its implementation.

The sample's SPreset script is downloaded remotely. It hooks generation and
prompt ordering, changes regex ordering, adds settings UI, and supports custom
request/output scripts. The CatGod menu depends on top-window access,
`localStorage`, observers, viewport measurements, computed styles, and
SillyTavern events. Those APIs are outside the current adapters. A host bridge
could expose selected events and measurements, but would not itself provide
these extensions' full behavior.

| Sample behavior | Status |
| --- | --- |
| Store, read, and export preset JSON with `/api/v1/presets` | Supported within current validation rules |
| Activate after removing undefined prompt-order entries | Supported, with warnings for unresolved entries |
| Assemble the complete prompt and custom markers | Not supported |
| Run embedded Tavern Helper scripts | Not supported; these are not `virtual-dom` ESM entries |
| Run SPreset generation or request hooks | Not supported |
| Display its menu and controls through the API | Not supported; rendering requires an explicitly adapted ESM entry |
| Run its remote scheduled task | Not supported; remote tasks are never started implicitly |

The upstream browser tree is retained under `compat-source/upstream/` for
reference and compatibility analysis. It is not served. The virtual DOM and
RPC adapters do not implement Tavern Helper, SPreset hooks, remote scheduled
tasks, or the CatGod menu. Android host design notes are in
[`android-extension-host.md`](android-extension-host.md).
