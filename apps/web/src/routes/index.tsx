import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({ component: Foundation });

function Foundation() {
  return <main style={{ fontFamily: 'system-ui', maxWidth: 760, margin: '48px auto', padding: 24 }}>
    <h1>Gotchu</h1>
    <p>Security platform foundation. Customer findings and approvals require an authenticated session and organization membership.</p>
    <p><a href="/api/auth/signin">Sign in</a> · <a href="/api/health">Service health</a> · <a href="/api/ready">Dependency readiness</a></p>
    <p>Runtime monitoring, cloud coverage, and corrections show explicit availability. A running dashboard does not establish that customer applications have been inspected.</p>
  </main>;
}
