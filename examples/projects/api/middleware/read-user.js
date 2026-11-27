// A stand-in for real auth. It trusts the bearer token as the user ID,
// which is fine for an example and never fine in production.
export async function readUser(requestContext, next) {
  let header = String(requestContext.request.headers.authorization ?? '');
  let token = header.replace(/^Bearer\s+/i, '');

  return await next({
    ...requestContext,
    context: {
      ...requestContext.context,
      user: token ? { id: token } : undefined
    }
  });
}
