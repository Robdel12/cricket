import { defineCricketApp } from '../src/app.js';

export function defineManualTestApp(options = {}) {
  return defineCricketApp({
    ...options,
    architecture: 'manual'
  });
}
