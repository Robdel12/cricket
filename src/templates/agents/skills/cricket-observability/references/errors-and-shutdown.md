# Errors and shutdown

## Report HTTP errors

`onError` receives the original error and a context with the request, route,
response, logger, `handled`, and `phase`. The request, route, or response may
be absent. A plain 500 response has no exception to report. Use `withError`
to attach an exception while keeping response validation.

Use `sentryErrorHandler` from `@robdel12/cricket/sentry` with the app's SDK.
It skips request-phase 4xx errors and can report later write or cleanup
failures. It adds request IDs and route templates. Scrub exception messages,
properties, and causes in the app or SDK.

HTTP observation callbacks get the event first and `{ logger, services }`
second. Protocol hosts use the same finish and close events, with an opaque
body summary. Keep transport objects and sensitive values outside app logs.

## Drain requests and stop

Read Cricket's `lifecycle` for runtime state. Check database, worker, and
product readiness in the app. `startCricketApp` resolves after listening and
returns an `origin`.

To pause admission without changing lifecycle readiness, call
`runtime.requests.pause()`. Await `hold.idle({ signal })` before changing
shared state. This waits for accepted handlers, streams, async cleanup, and
terminal observers, including after disconnect. Aborting the wait leaves the
hold in place. Call `hold.resume()` when ready and keep fixture or operator
control outside the paused runtime. Drain app workers and detached work
separately.

Standalone `stop()` runs `onShutdown` before draining. Use the hook to stop
producers and close long streams. Release app resources and flush the
reporting SDK in setup cleanup after draining. Cricket closes its database
after setup cleanup. Test runtime cleanup skips standalone shutdown hooks.
