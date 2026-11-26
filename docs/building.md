# Build and development

Install dependencies with pnpm, then run `pnpm build`. The build runs the
TypeScript checker and Vite's Node SSR build. It preserves the Node ESM module
tree under `dist/src/` so the standalone server and Messenger companion retain
their runtime layout.

Run `pnpm dev` for backend development. It builds the server, launches it, and
rebuilds/restarts it after source changes. This is a Node API development
watcher; there is no browser SPA or browser HMR in this Headless fork. Configure
the backend with the same `SILLYTAVERN_DATA_ROOT` and `SILLYTAVERN_PORT`
environment variables used by `pnpm start`.

`pnpm build:upstream-lib` builds the preserved upstream `lib.js` module with
Vite. Its cache/output is placed under `dist/_vite/` by default, or under
`$DATA_ROOT/_vite/` when `DATA_ROOT` is set.

## External compatibility

- `pnpm start`, `pnpm debug`, `package.json` `main`/`bin`, and the companion
  manifest continue to use `dist/src/*.js` and Node ESM.
- Companion `entry` remains `dist/src/headless-companion.js`; the bundle still
  carries separate worker modules and the existing production dependency
  manifest. Android runtime code does not need a new entry path.
- The internal `webpack.config.js` integration and `_webpack` cache path are
  removed. Tools importing that config or reading the old cache path must move
  to `pnpm build:upstream-lib` and the Vite cache layout.
- The Android/Gradle consumer is not present in this repository. The bundle
  manifest contract is preserved, but consumers that inspect compiler output
  paths beyond the manifest should be checked in their own repository.
