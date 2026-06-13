import {
  defineRule,
  forbidden
} from '../../../../../src/index.js';

export let isNamedBuild = defineRule('isNamedBuild', ({ input }) => {
  if (input.body.name === 'forbidden')
    return forbidden('Choose a better build name');
});
