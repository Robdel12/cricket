export let defaultMaxBodyBytes = 10 * 1024 * 1024;

let bytesByRequest = new WeakMap();

export function recordRequestBodyBytes(request, bytes) {
  bytesByRequest.set(request, (bytesByRequest.get(request) ?? 0) + bytes);
}

export function requestBodyBytes(request) {
  return bytesByRequest.get(request) ?? 0;
}
