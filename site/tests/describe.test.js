import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe } from '../scripts/generate.js';

test('a page description is its intro prose, without markdown', () => {
  let body = 'Use [the guide](guide.md) to add `jobs`.\n\n```sh\n# not a heading\nnot prose\n```\n\n- a list\n\nThen run **workers**.\n\n## Later\n\nIgnored.';
  assert.equal(describe(body), 'Use the guide to add jobs. Then run workers.');
});

test('long descriptions stop at a word with an ellipsis', () => {
  let description = describe('word '.repeat(60));
  assert.ok(description.length <= 160);
  assert.match(description, /word…$/);
});
