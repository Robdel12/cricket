function present(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

/** Adapt Cricket's onError hook to an app-owned, initialized Sentry SDK. */
export function sentryErrorHandler(sentry) {
  if (typeof sentry?.withScope !== 'function' || typeof sentry?.captureException !== 'function')
    throw new Error('sentryErrorHandler needs a Sentry SDK with withScope and captureException');

  return function onError(error, { request, response, route, handled = false, phase } = {}) {
    let status = response?.status;
    if (phase !== 'response' && status >= 400 && status < 500)
      return;

    return sentry.withScope(scope => {
      scope.setTags(present({
        framework: 'cricket',
        http_method: request?.method,
        http_status: status,
        operation: route?.operationId,
        error_handled: handled,
        error_phase: phase
      }));
      scope.setExtras(present({
        requestId: request?.id,
        route: route?.path
      }));
      sentry.captureException(error);
    });
  };
}
