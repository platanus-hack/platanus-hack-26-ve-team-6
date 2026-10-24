# Node security event client

`signEventBatch` implements the server's exact-byte HMAC protocol. `sendEventBatch` validates bounded input and makes at most three attempts, preserving event IDs and serialized content across retries. It never sends the signing key. Network and overload retries have five-second request deadlines and bounded delays. Permanent rejection is not retried.

Use this package only in trusted Node server code. Keep the integration key outside browser bundles. Callers own buffering, heartbeats, drop accounting, and when to flush; this delivery helper does not claim a durable client queue or complete monitoring coverage. Report exhausted deliveries as telemetry gaps.
