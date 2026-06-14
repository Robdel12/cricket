let statusByCode = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  EXPECTATION_FAILED: 417,
  TOO_MANY_REQUESTS: 429,
  NORMALIZER_CONTRACT_FAILED: 500,
  RESPONSE_CONTRACT_FAILED: 500,
  SERIALIZER_CONTRACT_FAILED: 500,
  VALIDATION_FAILED: 422
};

/**
 * Create the framework's standard error shape so Cricket can map it to HTTP.
 *
 * @param {string} code
 * @param {string} message
 * @param {object} [details]
 * @returns {Error & { code: string, details: object }}
 */
export function cricketError(code, message, details = {}) {
  let error = new Error(message);
  error.code = code;
  error.details = details;
  error.expose = true;
  return error;
}

/**
 * Create a 400 Bad Request framework error.
 *
 * @param {string} [message]
 * @param {object} [details]
 */
export function badRequest(message = 'Bad request', details) {
  return cricketError('BAD_REQUEST', message, details);
}

/**
 * Create a 413 Payload Too Large framework error.
 *
 * @param {string} [message]
 * @param {object} [details]
 */
export function payloadTooLarge(message = 'Payload too large', details) {
  return cricketError('PAYLOAD_TOO_LARGE', message, details);
}

/**
 * Create a 415 Unsupported Media Type framework error.
 *
 * @param {string} [message]
 * @param {object} [details]
 */
export function unsupportedMediaType(message = 'Unsupported media type', details) {
  return cricketError('UNSUPPORTED_MEDIA_TYPE', message, details);
}

/**
 * Create a 417 Expectation Failed framework error.
 *
 * @param {string} [message]
 * @param {object} [details]
 */
export function expectationFailed(message = 'Expectation failed', details) {
  return cricketError('EXPECTATION_FAILED', message, details);
}

/**
 * Create a 429 Too Many Requests framework error.
 *
 * @param {string} [message]
 * @param {object} [details]
 */
export function tooManyRequests(message = 'Too many requests', details) {
  return cricketError('TOO_MANY_REQUESTS', message, details);
}

/**
 * @param {string} [message]
 * @param {object} [details]
 */
export function unauthenticated(message = 'Unauthenticated', details) {
  return cricketError('UNAUTHENTICATED', message, details);
}

/**
 * @param {string} [message]
 * @param {object} [details]
 */
export function forbidden(message = 'Forbidden', details) {
  return cricketError('FORBIDDEN', message, details);
}

/**
 * @param {string} [message]
 * @param {object} [details]
 */
export function notFound(message = 'Not found', details) {
  return cricketError('NOT_FOUND', message, details);
}

/**
 * Normalize schema validation failures into the framework error format.
 *
 * @param {{ issues?: Array<any> }} error
 * @returns {Error & { code: string, details: { issues: Array<any> } }}
 */
export function validationFailed(error) {
  return cricketError('VALIDATION_FAILED', 'Validation failed', {
    issues: error.issues ?? []
  });
}

/**
 * Normalize response schema failures into the framework error format.
 *
 * @param {{ issues?: Array<any> }} error
 * @returns {Error & { code: string, details: { issues: Array<any> } }}
 */
export function responseContractFailed(error) {
  return cricketError('RESPONSE_CONTRACT_FAILED', 'Response contract failed', {
    issues: error.issues ?? []
  });
}

/**
 * Normalize serializer output schema failures into the framework error format.
 *
 * @param {{ issues?: Array<any> }} error
 * @returns {Error & { code: string, details: { issues: Array<any> } }}
 */
export function serializerContractFailed(error) {
  return cricketError('SERIALIZER_CONTRACT_FAILED', 'Serializer contract failed', {
    issues: error.issues ?? []
  });
}

/**
 * Normalize normalizer output schema failures into the framework error format.
 *
 * @param {{ issues?: Array<any> }} error
 * @returns {Error & { code: string, details: { issues: Array<any> } }}
 */
export function normalizerContractFailed(error) {
  return cricketError('NORMALIZER_CONTRACT_FAILED', 'Normalizer contract failed', {
    issues: error.issues ?? []
  });
}

/**
 * Convert a framework error into Cricket's HTTP payload shape.
 *
 * @param {Error & { code?: string, details?: { issues?: Array<any> } }} error
 * @returns {{ status: number, body: { error: { code: string, message: string, issues?: Array<any> } } }}
 */
export function toHttpError(error) {
  let code = error?.code ?? 'INTERNAL_SERVER_ERROR';
  let status = statusByCode[code] ?? 500;
  let expose = error?.expose === true || status < 500;

  return {
    status,
    body: {
      error: {
        code,
        message: expose ? (error?.message ?? 'Internal server error') : 'Internal server error',
        ...(error?.details?.issues ? { issues: error.details.issues } : {})
      }
    }
  };
}
