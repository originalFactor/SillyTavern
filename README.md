# SillyTavern Headless

An independent, headless SillyTavern-compatible backend. Clients use its
authenticated, versioned `/api/v1` API. The browser app is not included or
served. The fork keeps SillyTavern data formats and selected server and
extension adapters for native clients.

## Contents

- [Start](#start)
- [Compatibility](#compatibility)
- [Documentation](#documentation)
- [Maintenance and releases](#maintenance-and-releases)

## Start

Install Node.js 20 or newer and pnpm, then start the server:

```sh
pnpm install
pnpm start
```

The server listens on `127.0.0.1:8000` by default. At startup it creates a
fresh bearer capability and prints it in one `companion_ready` JSON line. Treat
that line as a secret. Set `SILLYTAVERN_PORT` or `SILLYTAVERN_DATA_ROOT` to
choose a different port or data directory. The standalone server accepts only
loopback connections.

## Compatibility

- The supported client interface is `/api/v1`. See the [API guide](docs/api/v1/README.md).
- Optional Express plugins run trusted code inside the server process. Enable
  them with `enableServerPlugins: true`.
- Headless extension hooks run in a worker and require the separate
  `api.v1.headlessPlugins` opt-in.
- The virtual DOM adapter supports UI construction and inspection, but does not
  provide browser layout or services. See [extension compatibility](docs/compatibility.md).

## Documentation

Browse the [documentation index](docs/README.md) for the API manual, endpoint
reference, compatibility notes, and Android extension-host design.

## Maintenance and releases

This fork is maintained independently; upstream changes are not merged
automatically. `AGENTS.md` records how retained upstream code is derived and
verified. Release versions live in `package.json`; releases should include the
API contract and compatibility guide. The source is licensed under AGPL-3.0;
see [LICENSE](LICENSE) for terms and attribution.
