/**
 * Define a named guard that can be run against an endpoint context.
 *
 * Rules stay tiny and composable: they receive the request context and either
 * resolve cleanly or return/throw an error that stops the request flow.
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
 * Run rules in order and stop on the first returned error.
 *
 * @param {Array<Function>} rules
 * @param {any} context
 * @returns {Promise<any|undefined>}
 */
export async function applyRules(rules, context) {
  for (let rule of rules ?? []) {
    let result = await rule(context);

    if (result instanceof Error)
      throw result;

    if (result)
      return result;
  }
}
