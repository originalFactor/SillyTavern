# Quick Setup

## On this page

- [Start the companion](#start-the-companion)
- [Make an authenticated request](#make-an-authenticated-request)

### Start the companion

From the repository, install dependencies and start the loopback companion:

```sh
pnpm install
pnpm start
```

The process prints one JSON line containing the port and a fresh bearer capability. Keep the capability private. The companion listens only on `127.0.0.1`; a native host passes the port and capability to its client. The capability changes at every start.

### Make an authenticated request

```sh
curl http://127.0.0.1:8000/api/v1/capabilities \
  -H "Authorization: Bearer <capability>"
```

Use the actual port and capability from the startup line. Every request, including reads, needs authentication. JSON requests use `Content-Type: application/json`. Do not put credentials in URLs or logs.

For a regular SillyTavern host, enable API v1 in its configuration and use its normal authenticated session. Mutating cookie-session requests also require the CSRF token. The standalone companion uses bearer authentication and does not use cookies or CSRF.
