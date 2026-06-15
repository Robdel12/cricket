import {
  defineRule,
  forbidden,
  unauthenticated
} from '../../../../../src/index.js';

export let requireUser = defineRule('requireUser', ({ user }) => {
  if (!user)
    return unauthenticated();
});

export let isNamedBuild = defineRule('isNamedBuild', ({ input }) => {
  if (input.body.name === 'forbidden')
    return forbidden('Choose a better build name');
});
