# Embedded WorkBuddy security node

This directory ships with the npm package. Runtime imports use only the installed plugin and Node builtins; no sibling checkout or compiler is needed.

Copied from the WorkBuddy working tree on 2026-11-16: scripts/security-node-service.mjs, scripts/security-node-fs.py and src/node-security.ts (preserved in source/node-security.ts).

Unchanged source SHA-256:

- security-node-fs.py: b5d76eb100f970efa6fa00681fbd80e67839e138e4fb08db5f19f5b51d332356
- source/node-security.ts: 14701ddd94415aab530131102f599d64b19a670014a901c1d3d128c485f14834

The service changes only add broker stdio/completion handling, running state, startup cleanup, idempotent close awaiting broker exit, listener shutdown after broker exit and an explicit missing Linux rootfs diagnostic. Path restrictions and permissions are preserved.

Rebuild protocol from the plugin root:

~~~sh
node node_modules/typescript/bin/tsc vendor/security-node/source/node-security.ts --outDir vendor/security-node --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --types node --declaration --sourceMap false
~~~

The lifecycle adapter is src/node-runtime.ts. Constructor accepts dir, keyStore, getRoots and getDshRef. getRoots supplies exact registry roots including default cwd fallback. getDshRef supplies baseUrl and apiKey; only the direct DSH locator enters a pairing response.

- prepare(): persistent identity and loopback port 0 startup; root reconciliation and optional locator refresh; no new pairing ticket.
- handle(req,res): boolean, forwards /v1/ with runtime.server.emit request. Call before middleware consumes the body; unavailable runtime returns 503.
- status(): synchronous public status without API keys or pairing secrets.
- createPairing(): pairingCode/expiresAt/nodeId/name; five-minute wbpair1; atomic 0600 hash-only pairing.json; regeneration invalidates the previous ticket.
- pause(): stops listener and broker, allows future prepare.
- close(): terminal shutdown, awaits broker exit.

Node state remains outside all exported roots. Root /, duplicates and broader overlapping roots are excluded. Narrower registered roots remain. Original Unix ownership, no-symlink and private-ancestor rules apply.

macOS uses original pinned-descriptor filesystem mode. Linux uses openat2. The adapter does not provision a bwrap rootfs and reports isolation.available=false; execution is rejected. Windows, root and missing /usr/bin/python3 report unavailable errors. agents/invoke remains unavailable without explicit text-only inference; host agent sessions are not substituted.

Verification:

~~~sh
node --test scripts/test-node-runtime.mjs
WORKBUDDY_SOURCE=../onenat-workbuddy-web node --test scripts/test-node-runtime.mjs
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
~~~

Tests compile an independent installed-package fixture and exercise real HTTP/Python. Optional WORKBUDDY_SOURCE compiles the original client for interoperability; it is not required at runtime. Native macOS tested, plus simulated Windows/root/missing-Python preflight; Linux isolation and native Windows not exercised.

Plugin-side change (2026-11-17, dsh-web-service): `catalog/resolve` in `security-node-service.mjs` falls back to registering a resolved workspace without directory entries when the broker refuses strict enumeration (`UNSAFE_FILE`/`UNTRUSTED_FILE`/`FILE_TOO_LARGE`/`DIRECTORY_TOO_LARGE`), so workspace registration is not blocked by directory content (symlinks in real dev directories). Actual file listings keep the strict checks; `security-node-fs.py` and `source/node-security.ts` are unchanged.
