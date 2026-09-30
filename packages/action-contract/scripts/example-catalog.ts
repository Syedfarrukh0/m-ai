/**
 * Writes examples/action-catalog.example.json from the test fixture app, so
 * apps can see exactly what a catalog looks like and the assistant can build
 * against it before a real app publishes one.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeApp } from '../test/fixtures/app.js';

const { registry } = makeApp();
const catalog = registry.catalog();
const hash = await registry.catalogHash();
const target = fileURLToPath(new URL('../examples/action-catalog.example.json', import.meta.url));
writeFileSync(target, `${JSON.stringify({ catalogHash: hash, ...catalog }, null, 2)}\n`);
console.log(`wrote ${catalog.actions.length} actions, ${catalog.events.length} events, ${catalog.errors.length} errors → ${target}`);
