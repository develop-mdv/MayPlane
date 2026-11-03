import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pendingMigrations,
  unresolvedMigrationQuestions,
} from '../lib/migration-flow.mjs';
test('pending transfers include plans without jobs, drafts and recovery but not completed moves', () => {
  const base = {
    id: 'p',
    serverId: 's',
    migrationPlan: {
      sourceId: 's',
      targetId: 't',
      jobId: 'plan',
      createdAt: '2026-09-10',
      blockers: ['Conflict'],
      mode: 'llm',
    },
  };
  assert.equal(pendingMigrations([base], [])[0].state, 'decision');
  assert.equal(pendingMigrations([{ ...base, serverId: 't' }], []).length, 0);
  assert.equal(
    pendingMigrations(
      [
        {
          id: 'new',
          serverId: 's',
          migrationDraft: { sourceId: 's', targetId: 't', jobId: 'draft' },
        },
      ],
      [],
    )[0].state,
    'retry',
  );
  assert.equal(
    pendingMigrations(
      [
        {
          id: 'r',
          serverId: 's',
          migration: {
            locked: true,
            needsRecovery: true,
            sourceId: 's',
            targetId: 't',
          },
        },
      ],
      [],
    )[0].state,
    'recovery',
  );
  assert.equal(
    pendingMigrations(
      [base],
      [
        {
          id: 'j',
          type: 'migration-plan',
          projectId: 'p',
          status: 'deploying',
        },
      ],
    )[0].state,
    'checking',
  );
});
test('archive choice never answers unrelated access or external database questions', () => {
  const questions = [
    'Разрешить архивирование существующих контейнеров?',
    'Укажите пароль внешней базы',
    'Подтвердите архивирование каталога и укажите токен',
  ];
  assert.deepEqual(
    unresolvedMigrationQuestions(questions, {
      selected: true,
      available: true,
    }),
    questions.slice(1),
  );
  assert.deepEqual(
    unresolvedMigrationQuestions(questions, {
      selected: false,
      available: true,
    }),
    questions,
  );
});

test('manual preparation clears only the old conflict question when fresh preflight is clean', () => {
  const question = 'Разрешить архивирование существующих контейнеров?';
  assert.deepEqual(
    unresolvedMigrationQuestions([question, 'Укажите пароль'], null, {
      blockers: [],
    }),
    ['Укажите пароль'],
  );
  assert.deepEqual(
    unresolvedMigrationQuestions([question], null, {
      blockers: ['SSH failed'],
    }),
    [question],
  );
});

test('returning to an earlier server does not resurrect an already completed saved plan', () => {
  const project = {
    id: 'p',
    serverId: 's',
    savedMigrationPlan: {
      sourceId: 's',
      targetId: 't',
      createdAt: '2026-01-01',
      jobId: 'old',
    },
    migration: { phase: 'complete', finishedAt: '2026-02-01', locked: false },
  };
  assert.deepEqual(pendingMigrations([project], []), []);
  project.migrationDraft = {
    sourceId: 's',
    targetId: 't',
    updatedAt: '2026-03-01',
    jobId: 'new',
  };
  assert.equal(pendingMigrations([project], [])[0].jobId, 'new');
});
