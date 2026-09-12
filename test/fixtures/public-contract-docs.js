import { defineCricketApp } from '../../src/index.js';
import { app as example } from '../../examples/public-contracts.js';

export let app = defineCricketApp({
  name: example.name,
  version: example.version,
  domains: example.domains,
  securitySchemes: example.securitySchemes,
  setup() {
    throw new Error('Documentation must not initialize application services');
  }
});
