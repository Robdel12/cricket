# HTTP contracts

## Choose a request type

- Use a normal handler for parsed input. Use `rawBody` if you need the original
  bytes, such as for webhook signature checks. Use `multipart` for form fields
  and files. Files in `request.files` are temporary. Copy or move the files you
  need before the request ends. Set multipart limits on the endpoint, or use
  app `requestBodyLimits` keyed by operation ID for deployment-specific byte limits.
  Use `beforeBodyRules` when access must be checked before an upload is read.
  A rule can return a Cricket response to end the request early.
- Use `fetch(request, context)` with an integration built around web
  `Request` and `Response`. Keep rules for access, set `maxBodyBytes`, and
  honor `request.signal`. Declare allowed statuses and media types with
  `fetchResponses`. The body stays streamed. Fetch rejects `body`, `rawBody`,
  `multipart`, `apiVersions`, `requestBody`, `response`, and `responses`.
  Params, query, and header validation still work.

## Describe responses

- Use `authMethods` on the app and `auth` on the endpoint for OpenAPI. Enforce
  access in rules or middleware. Use lowercase keys in request header schemas.
- Use `requestBody.files` to document multipart files and `requestBody.schema`
  for raw bodies. Enforce these contracts in app code. Use `jsonSchema` metadata
  for wire types Cricket cannot infer. Numeric `z.coerce.number()` params and
  query fields have schema support. Coerced request body values need explicit
  wire metadata.
- Use status-specific `responses` for different output schemas. Use
  `contentTypes` if the same schema is served in several media types and set
  the actual response header with `withHeaders`. OpenAPI uses the serializer's
  public output schema when the response includes a serializer.
- For known-length streams, set `Content-Length` with `withHeaders`. Cricket
  checks the byte count. HEAD preserves the length without reading the stream.
  Use `withResponseCleanup` to release app resources.

## Keep old clients working

Reuse one `defineApiVersions` family across the endpoints that share a version
policy. Keep the current contract on the endpoint. Put historical body
normalizers and response serializers in `apiVersions`. Validate normalized
bodies against the current body schema and keep historical output schemas explicit.

Use `response: { schema, serializer }` when the canonical response differs
from the current public output. Rules and handlers can use the negotiated
`apiVersion` to decide which data they need and pass those requirements to
services. Test each supported version through HTTP and regenerate each
published OpenAPI projection. A sunset date announces retirement. Remove the
version and its deltas when support ends.

## Configure the HTTP edge

- Set app `trustProxy` to verified peer IPs or CIDRs. Trust is off by default.
  Have the proxy overwrite forwarded host and protocol. Read `request.clientIp`,
  `request.peerIp`, and `request.proxyTrusted` from Cricket. The app owns host
  allowlists.
- Use app `responseHeaders(request)` for defaults and `requestPolicy({ request })`
  for early responses such as trusted-origin preflight. Policy runs before
  protocol hosts and normal middleware. Explicit response headers take
  precedence over defaults. Cricket merges `Vary` tokens and respects headers
  reserved by the protocol host.
- Add `defineOAuthPlugin({ paths, serviceName: 'oauth' })` from
  `@robdel12/cricket/oauth` for authorization code with S256 PKCE and opaque
  access and refresh tokens. Install the plugin on the app and compose
  `services.oauth` when setup dependencies and domain services are ready.
  Keep account checks, consent, UI, and storage in the app. Run code consumption,
  token rotation, and revocation in the app store's transaction.
