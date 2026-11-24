# SillyTavern Headless API v1

Client manual for the versioned SillyTavern Headless API. Use [OpenAPI](openapi.yaml) as the machine-readable contract; this manual explains the behavior clients need to use it.

## Contents

- [Introduction](chapters/introduction.md)
- [Quick Setup](chapters/quick-setup.md)
- [Guide](chapters/guide.md)
- [Native client implementation guide](client-implementation.md)
- [What is missing from the V1 client/API port](what-is-missing.md)
- [Tutorial: preview and send a generation](chapters/tutorial.md)
- [Global Concepts](chapters/global-concepts.md)
- [Endpoint Reference](reference/README.md)
- [OpenAPI schema](openapi.yaml)
- [JSON Schemas](schema/README.md)

## Quick orientation

The companion listens on loopback and authenticates every request with a fresh bearer capability. Start with the [Quick Setup](chapters/quick-setup.md), then check [capabilities](reference/discovery.md) before offering optional features. Use the [generation guide](chapters/guide.md#submit-generations-safely) to handle accepted, interrupted, and uncertain requests safely.
