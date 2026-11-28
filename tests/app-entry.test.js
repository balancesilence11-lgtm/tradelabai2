import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('production app entry loads the integrated main application', () => {
  assert.match(indexHtml, /<script\s+type=["']module["']\s+src=["']\/src\/main\.jsx["']\s*>\s*<\/script>/i);
  assert.equal(existsSync(new URL('../src/main.jsx', import.meta.url)), true);
});
