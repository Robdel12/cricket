/**
 * Define a named guard that can be run against an endpoint context.
 *
 * Rules stay tiny and composable: they receive the request context and either
 * return plain facts for the next rule/handler or return/throw an error that
 * stops the request flow.
 *
 * @param {string} name
 * @param {(context: any) => any|Promise<any>} check
 * @returns {(context: any) => Promise<any>}
 */
export function defineRule(name, check) {
  if (!name) throw new Error('Rule name is required');
  if (typeof check !== 'function')
    throw new Error(`Rule ${name} needs a check function`);

  let rule = async context => check(context);
  rule.ruleName = name;
  return rule;
}

/**
 * Run rules in order, threading returned facts into the next rule context.
 *
 * @param {Array<Function>} rules
 * @param {any} context
 * @returns {Promise<any>}
 */
export async function applyRules(rules, context) {
  let currentContext = context;

  for (let rule of rules ?? []) {
    let result = await rule(currentContext);

    if (result instanceof Error)
      throw result;

    if (!result)
      continue;

    if (isPlainObject(result)) {
      currentContext = mergeRuleFacts(currentContext, result, rule);
      continue;
    }

    throw new Error(`Rule ${rule.ruleName ?? 'unknown'} must return a plain object or Error`);
  }

  return currentContext;
}

function isPlainObject(value) {
  return value &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function mergeRuleFacts(context, facts, rule) {
  for (let key of Object.keys(facts)) {
    if (Object.hasOwn(context, key))
      throw new Error(`Rule ${rule.ruleName ?? 'unknown'} cannot replace context.${key}`);
  }

  return {
    ...context,
    ...facts
  };
}
