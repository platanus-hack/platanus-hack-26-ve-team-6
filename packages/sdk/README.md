# Gotchu Node SDK

The SDK sends signed application events and provides opt-in runtime protection for Node HTTP applications. It has no runtime dependency beyond Node and `@gotchu/contracts`. Keep the integration signing key in server-only environment configuration; never put it in a browser bundle or log it.

## Runtime protection

Create one guard for the application, install its middleware after request parsing and before routes, and explicitly use the guard's wrappers at the relevant sinks. The default policy is `monitor`. An Owner or Operator can select `block` and enable detectors in the Gotchu application settings. Policy is fetched over the existing HMAC integration channel, signed for the application, cached briefly, and expires after 30 seconds. If no valid policy is available, the SDK uses monitor mode. Events use the existing signed, replay-protected event endpoint.

```ts
import express from 'express';
import { createGotchuGuard, GotchuProtectionBlockedError } from '@gotchu/sdk';

const guard = createGotchuGuard({
  integrationId: process.env.GOTCHU_INTEGRATION_ID ?? '',
  applicationId: process.env.GOTCHU_APPLICATION_ID ?? '',
  secret: Buffer.from(process.env.GOTCHU_SIGNING_KEY ?? '', 'base64'),
  baseUrl: process.env.GOTCHU_URL ?? '',
});

const app = express();
app.use(express.json());
app.use(guard.middleware());

app.get('/search', async (request, response, next) => {
  const searchTerm = String(request.query.q ?? '');
  const sql = 'SELECT id FROM users WHERE name = $1';
  try {
    // Substitute the app's SQL client. Bound values stay out of SQL syntax.
    await guard.sql(sql, () => database.query(sql, [searchTerm]));
    response.sendStatus(200);
  } catch (error) {
    if (error instanceof GotchuProtectionBlockedError) return response.sendStatus(403);
    next(error);
  }
});
```

For plain `node:http`, wrap the server handler with `guard.nodeHttpHandler(handler)`. The middleware gathers bounded route, path, query, parameter, and parsed-body strings into request-local context; it does not monkey-patch Node globals. Use the sink wrapper with the real argument that will be passed to the operation:

```ts
await guard.filePath(requestedPath, uploadsRoot, resolved => readFile(resolved));
await guard.exec(commandLine);
await guard.fetch(request.query.url);
```

Available wrappers are `sql(query, execute)`, `filePath(path, root, execute)`, `command(text, execute)`, `exec`, `execFile`, `spawn`, `fetch`, and `httpRequest(url, execute)`. The wrappers throw `GotchuProtectionBlockedError` before the callback/sink in block mode. In monitor mode they report an indication and continue. `fetch` disables redirects; an `httpRequest` callback must enforce its own redirect policy.

Detectors are deliberately narrow and require request data to flow into a wrapped argument:

- SQL checks raw query text containing the exact request value and a small set of tautology, `UNION SELECT`, statement-chain, or comment-termination structures. Parameterized SQL is not flagged merely because a parameter contains words like “select” or “from”. This is not SQL parsing and does not cover query builders unless their actual SQL string is wrapped.
- Path traversal checks whether the requested path contains request input and resolves outside the caller-supplied root. `filePath` passes the resolved path to its callback.
- Command injection checks shell operators in request input that also appears in the command string. `exec` is shell-based; `execFile` and `spawn` are checked only when shell mode is enabled. Direct argument execution remains available.
- SSRF checks a request-derived `fetch`/HTTP destination against literal and DNS-resolved private, loopback, link-local, reserved, and metadata addresses. The check is bounded; DNS rebinding between inspection and connection is not eliminated. A custom `httpRequest` callback can follow redirects or use a different resolver, so it must apply its own destination controls.

These are sink guards, not transparent runtime instrumentation. Direct use of `fs`, database clients, `child_process`, or HTTP clients is not intercepted unless routed through a guard wrapper. The middleware sees raw URL inputs and parsed Express values; for other frameworks use `runWithContext({ route, userInputs }, callback)` or `nodeHttpHandler`. Frameworks that parse bodies after the middleware require explicit `runWithContext` or middleware placement after their body parser.

The SDK sends only detector kind, sink, templated route, bounded evidence category, outcome, timestamps, and event IDs. It never sends the input, query, path, command, URL, headers, or body. The in-memory queue is capped at 100 events; overflow and failed delivery are counted in `guard.status().droppedEvents`. Delivery is batched and bounded by request timeouts, but the queue is not durable across process exit. Gotchu unavailability does not fail the host request; after policy expiry the guard falls back to monitor mode. No production false-positive, latency, throughput, DNS-rebinding, or broad framework-coverage claim has been measured.

Close the guard during application shutdown with `await guard.close()` to stop its timer and flush the remaining best-effort batch.

## Signed telemetry helpers

`httpRequestEvent` creates a bounded request metric, and `applicationErrorEvent` creates a categorized error event. `signEventBatch` implements the server's exact-byte HMAC protocol. `sendEventBatch` validates bounded input and makes at most three attempts, preserving event IDs and serialized content across retries. It never sends the signing key. Permanent rejection is not retried. Report exhausted deliveries as telemetry gaps.
