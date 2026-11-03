import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnvDocument, serializeEnvDocument } from '../lib/environment.mjs';
import { envEntries, redact } from '../runner/security.mjs';

const row = (key, value, interpolate = false) => ({
  id: key,
  key,
  value,
  interpolate,
});

test('field edits preserve untouched comments, quoting, CRLF and references exactly', () => {
  const source =
    '# deployment\r\nexport TOKEN = \'old # value\'\r\nURL="https://${HOST}/path" # kept\r\nEMPTY=\r\n';
  const document = parseEnvDocument(source);
  assert.equal(serializeEnvDocument(document), source);
  document.rows[0].value = 'new = # literal $TOKEN';
  const result = serializeEnvDocument(document);
  assert.ok(
    result.startsWith('# deployment\r\nTOKEN="new = # literal $$TOKEN"\r\n'),
  );
  assert.ok(result.endsWith('URL="https://${HOST}/path" # kept\r\nEMPTY=\r\n'));
  assert.equal(envEntries(result)[0][1], 'new = # literal $TOKEN');
});

test('fields support renaming, deleting, adding and empty values without changing neighbors', () => {
  const document = parseEnvDocument(
    "export OLD = 'value' # keep\nREMOVE=x\nKEEP=y",
  );
  document.rows[0].key = 'RENAMED';
  document.rows.splice(1, 1);
  document.rows.push(row('EMPTY', ''), row('NEW', 'x=y'), row('', ''));
  const result = serializeEnvDocument(document);
  assert.equal(
    result,
    'export RENAMED = \'value\' # keep\nKEEP=y\nEMPTY=""\nNEW="x=y"\n',
  );
  assert.deepEqual(envEntries(result), [
    ['RENAMED', 'value'],
    ['KEEP', 'y'],
    ['EMPTY', ''],
    ['NEW', 'x=y'],
  ]);
  document.rows = [];
  assert.equal(serializeEnvDocument(document), '');
});

test('literal field values round trip and decoded secrets are redacted', () => {
  const values = [
    '$TOKEN ${TOKEN} $$double',
    '  leading and trailing  ',
    '# hash = equals',
    'double "quote" and single \'quote\'',
    'C:\\data\\',
    'slash\\"quote',
    'line one\nline two\r\tend',
    '\\n stays literal',
    'кириллица 🔑',
    '',
  ];
  const text = serializeEnvDocument({
    source: '',
    rows: values.map((value, i) => row('KEY_' + i, value)),
  });
  const entries = envEntries(text);
  assert.deepEqual(
    entries.map((entry) => entry[1]),
    values,
  );
  const nonempty = values.filter(Boolean);
  assert.equal(
    redact(
      nonempty.join('|'),
      entries.map((entry) => entry[1]),
    ),
    nonempty.map(() => '[REDACTED]').join('|'),
  );
});

test('invalid imports and fields fail without echoing secret values', () => {
  for (const text of [
    'KEY=one\nKEY=two',
    'KEY="secret-without-close',
    'KEY="secret" extra',
    'KEY=secret\0',
    'BAD LINE',
    'KEY=é'.repeat(16000),
  ]) {
    assert.throws(() => parseEnvDocument(text));
  }
  for (const rows of [
    [row('1BAD', 'secret')],
    [row('KEY', 'a'), row('KEY', 'b')],
    [row('', 'secret')],
  ]) {
    assert.throws(() => serializeEnvDocument({ source: '', rows }));
  }
  assert.deepEqual(
    envEntries(
      "A=\"hello\\nworld\" # comment\nB=hash#here\nC=hello # comment\nD='Let\\'s go'",
    ),
    [
      ['A', 'hello\nworld'],
      ['B', 'hash#here'],
      ['C', 'hello'],
      ['D', "Let's go"],
    ],
  );
});

// This checks the external consumer without pulling images or starting containers.
const docker = spawnSync('docker', ['compose', 'version'], {
  encoding: 'utf8',
  timeout: 10000,
  windowsHide: true,
});
test(
  'Docker Compose receives literal field values and retains imported interpolation',
  { skip: docker.status !== 0 },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'ezdeploy-env-compose-'));
    try {
      const values = [
        '$HOME ${USER} $$',
        '  # value =  ',
        'C:\\data\\',
        'slash\\"quote',
        'one\ntwo\tthree',
        "Let's go",
        'path\\$SECRET',
      ];
      const document = parseEnvDocument(
        'BASE=host\nREF=${BASE}/path\nESCAPED="\\$BASE"\nMIX="$$BASE/${BASE}"\n',
      );
      document.rows.find((row) => row.key === 'MIX').value += '/edited';
      document.rows.push(...values.map((value, i) => row('VALUE_' + i, value)));
      writeFileSync(join(dir, '.env'), serializeEnvDocument(document));
      writeFileSync(
        join(dir, 'compose.json'),
        JSON.stringify({
          services: {
            app: {
              image: 'busybox',
              env_file: '.env',
              environment: { EXPLICIT: '${VALUE_0}' },
            },
          },
        }),
      );
      const result = spawnSync(
        'docker',
        [
          'compose',
          '--project-name',
          'ezdeploy-env-test',
          '--env-file',
          join(dir, '.env'),
          '-f',
          join(dir, 'compose.json'),
          'config',
          '--format',
          'json',
        ],
        { encoding: 'utf8', timeout: 15000, windowsHide: true },
      );
      assert.equal(result.status, 0, result.stderr);
      // Compose re-escapes every dollar in config output so the document can be reused.
      const environment = JSON.parse(result.stdout.replace(/\$\$/g, () => '$'))
        .services.app.environment;
      for (const [index, value] of values.entries())
        assert.equal(environment['VALUE_' + index], value);
      assert.equal(environment.EXPLICIT, values[0]);
      assert.equal(environment.REF, 'host/path');
      assert.equal(environment.ESCAPED, '$BASE');
      assert.equal(environment.MIX, '$BASE/host/edited');
    } finally {
      assert.ok(dir.startsWith(join(tmpdir(), 'ezdeploy-env-compose-')));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
