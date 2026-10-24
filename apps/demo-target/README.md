# Controlled fictional store

Only two HTTP routes are served: `GET /vulnerable` and `GET /corrected`. They return a small fictional stationery catalog. Source/configuration/manifest fixtures are never served over HTTP. The target has no login, real customer data, secrets, dependency installation, execution endpoint, or provider connection.

```sh
pnpm --filter @gotchu/contracts build
pnpm --filter @gotchu/demo-target build
pnpm --filter @gotchu/demo-target start
```

The server binds `127.0.0.1:4100` by default. `GOTCHU_DEMO_HOST` and `GOTCHU_DEMO_PORT` are operator-only settings. Binding is limited to a literal loopback or RFC1918 IPv4 address; wildcard/public interfaces are rejected. Stop with SIGINT or SIGTERM.

For real tests:

```ts
import { startDemoTargetServer } from '@gotchu/demo-target';
const target = await startDemoTargetServer({ host: '127.0.0.1', port: 0 });
try {
  // target.origin includes the assigned ephemeral port.
} finally {
  await target.close();
}
```

The vulnerable fixture deliberately omits Content-Security-Policy and retains an internal diagnostic setting that includes fictional customer email in audit text. The corrected fixture supplies a restrictive policy and redacts that text. Fixture manifests are inventory samples, not installed dependencies. Both routes carry an operator-side fictional technology banner, allowing an external-only indication without inventing an installed technology or treating it as compromise.
