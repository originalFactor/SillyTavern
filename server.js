#!/usr/bin/env node
// Compatibility entry path retained for existing scripts and global installs.
// All supported startup paths use the authenticated headless server.
await import('./dist/src/headless-server.js');
