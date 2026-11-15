function headerEntries(headers = {}) {
  return Object.entries(headers).map(([name, value]) => [name.toLowerCase(), name, value]);
}

function varyTokens(value) {
  return (Array.isArray(value) ? value : [value])
    .flatMap(entry => String(entry).split(','))
    .map(token => token.trim())
    .filter(Boolean);
}

function mergeVary(defaultValue, explicitValue) {
  let explicitTokens = varyTokens(explicitValue);
  let defaultTokens = varyTokens(defaultValue);
  if ([...explicitTokens, ...defaultTokens].includes('*'))
    return '*';

  let seen = new Set(explicitTokens.map(token => token.toLowerCase()));
  let tokens = [...explicitTokens];
  for (let token of defaultTokens) {
    let normalized = token.toLowerCase();
    if (!seen.has(normalized)) {
      tokens.push(token);
      seen.add(normalized);
    }
  }
  return tokens.join(', ');
}

export function mergeDefaultHeaders(defaults = {}, explicit = {}) {
  let merged = new Map(headerEntries(defaults).map(([normalized, name, value]) => [
    normalized,
    [name, value]
  ]));

  for (let [normalized, name, value] of headerEntries(explicit)) {
    let defaultEntry = merged.get(normalized);
    if (normalized === 'vary' && defaultEntry)
      merged.set(normalized, [name, mergeVary(defaultEntry[1], value)]);
    else
      merged.set(normalized, [name, value]);
  }

  return Object.fromEntries(merged.values());
}
