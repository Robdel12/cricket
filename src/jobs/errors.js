import { cricketError } from '../errors.js';

export function jobContractFailed(message, details = {}) {
  return cricketError('JOB_CONTRACT_FAILED', message, details);
}

export function jobInputFailed(error) {
  return cricketError('JOB_INPUT_FAILED', 'Job input failed validation', {
    issues: error.issues ?? []
  });
}

export function jobContextFailed(error) {
  return cricketError('JOB_CONTEXT_FAILED', 'Job context failed validation', {
    issues: error.issues ?? []
  });
}

export function jobResultFailed(error) {
  return cricketError('JOB_RESULT_FAILED', 'Job result failed validation', {
    issues: error.issues ?? []
  });
}
