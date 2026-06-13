let statusByCode = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RESPONSE_CONTRACT_FAILED: 500,
  VALIDATION_FAILED: 422
};

/**
 * Create the framework's standard error shape so adapters can map it to HTTP.
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
  return error;
}

/**
 * @param {string} [message]
 * @param {object} [details]
 */
export function badRequest(message = 'Bad request', details) {
  return cricketError('BAD_REQUEST', message, details);
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
 * Convert a framework error into the HTTP payload shape adapters return.
 *
 * @param {Error & { code?: string, details?: { issues?: Array<any> } }} error
 * @returns {{ status: number, body: { error: { code: string, message: string, issues?: Array<any> } } }}
 */
export function toHttpError(error) {
  let code = error?.code ?? 'INTERNAL_SERVER_ERROR';

  return {
    status: statusByCode[code] ?? 500,
    body: {
      error: {
        code,
        message: error?.message ?? 'Internal server error',
        ...(error?.details?.issues ? { issues: error.details.issues } : {})
      }
    }
  };
}
