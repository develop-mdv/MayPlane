import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { openStore } from '../runner/store.mjs';
test('a differently named database cannot silently create an empty MayPlane installation', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mayplane-namespace-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'previous.sqlite'), 'preserved database');
  assert.throws(
    () => openStore(directory, randomBytes(32)),
    /mayplane\.sqlite/,
  );
  assert.ok(!existsSync(join(directory, 'mayplane.sqlite')));
});
