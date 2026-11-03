'use client';
import type { EnvDefinition } from '@/lib/domain';
import { useId, useState } from 'react';
import { Eye, EyeOff, Plus, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  parseEnvDocument,
  serializeEnvDocument,
  type EnvDocument,
  type EnvRow,
} from '@/lib/environment.mjs';

export function EnvironmentFields({
  document,
  onChange,
  disabled = false,
  readOnly = false,
  requiredKeys = [],
  definitions = [],
}: {
  document: EnvDocument;
  onChange: (document: EnvDocument) => void;
  disabled?: boolean;
  readOnly?: boolean;
  requiredKeys?: string[];
  definitions?: EnvDefinition[];
}) {
  const id = useId();
  const definitionFor = (name: string) =>
    definitions.find((e) => e.name === name) || {
      name,
      required: requiredKeys.includes(name) ? true : null,
      description: '',
    };
  const missing = [
    ...new Set([
      ...requiredKeys,
      ...definitions.filter((e) => e.required === true).map((e) => e.name),
    ]),
  ].filter(
    (name) =>
      !document.rows.some((row) => row.key === name && row.value.trim()),
  );
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [importError, setImportError] = useState('');
  let validation = '';
  try {
    serializeEnvDocument(document);
  } catch (error) {
    validation = (error as Error).message;
  }
  function change(rowId: string, patch: Partial<EnvRow>) {
    onChange({
      ...document,
      rows: document.rows.map((row) =>
        row.id === rowId ? { ...row, ...patch } : row,
      ),
    });
  }
  return (
    <fieldset className="environment-fields" disabled={disabled}>
      <legend>Переменные окружения</legend>
      <p className="env-hint">
        {readOnly
          ? 'Снимок переменных с сервера. Значения доступны только для просмотра.'
          : 'Каждую переменную можно изменить отдельно. Значения вводите без обрамляющих кавычек. Пустые необязательные поля можно оставить — применятся настройки приложения.'}
      </p>
      {!readOnly && !!missing.length && (
        <p className="env-required-notice">
          Для развёртывания заполните: {missing.join(', ')}. Сохранить изменения
          можно и до заполнения всех полей.
        </p>
      )}
      {document.rows.map((row, index) => {
        const shown = visible.has(row.id);
        const multiline = /[\r\n]/.test(row.value);
        const definition = definitionFor(row.key);
        const required = definition.required === true;
        const placeholder = required
          ? 'Заполните перед деплоем'
          : definition.required === false
            ? 'Можно оставить пустым'
            : 'Значение';
        return (
          <div
            className={`environment-row ${required && !row.value.trim() ? 'environment-missing' : ''}`}
            key={row.id}
          >
            {!!row.key && (
              <div className="environment-requirement">
                <EnvRequirement definition={definition} />
              </div>
            )}
            <label className="form-field" htmlFor={`${id}-${row.id}-key`}>
              <span>Имя</span>
              <Input
                id={`${id}-${row.id}-key`}
                aria-label={`Имя переменной ${index + 1}`}
                readOnly={readOnly}
                value={row.key}
                onChange={(e) => change(row.id, { key: e.target.value })}
                placeholder="API_KEY"
                pattern="[A-Za-z_][A-Za-z0-9_]*"
                required={!!row.value || row.line !== undefined}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
            <div className="environment-value">
              <label className="form-field" htmlFor={`${id}-${row.id}`}>
                <span>Значение</span>
              </label>
              <div className="environment-value-input">
                {shown ? (
                  <Textarea
                    id={`${id}-${row.id}`}
                    aria-label={`Значение ${row.key || index + 1}`}
                    readOnly={readOnly}
                    value={row.value}
                    onChange={(e) => change(row.id, { value: e.target.value })}
                    rows={multiline ? 3 : 1}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={placeholder}
                  />
                ) : (
                  <Input
                    id={`${id}-${row.id}`}
                    aria-label={`Значение ${row.key || index + 1}`}
                    type="password"
                    value={multiline ? '••••••••' : row.value}
                    readOnly={readOnly || multiline}
                    onChange={(e) => change(row.id, { value: e.target.value })}
                    autoComplete="new-password"
                    placeholder={
                      multiline ? 'Многострочное значение' : placeholder
                    }
                  />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  aria-label={`${shown ? 'Скрыть' : 'Показать'} значение ${row.key || index + 1}`}
                  aria-pressed={shown}
                  onClick={() =>
                    setVisible((previous) => {
                      const next = new Set(previous);
                      if (shown) next.delete(row.id);
                      else next.add(row.id);
                      return next;
                    })
                  }
                >
                  {shown ? <EyeOff size={16} /> : <Eye size={16} />}
                </Button>
              </div>
            </div>
            {!readOnly && (
              <Button
                className="environment-remove"
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                aria-label={`Удалить переменную ${row.key || index + 1}`}
                onClick={() =>
                  onChange({
                    ...document,
                    rows: document.rows.filter((item) => item.id !== row.id),
                  })
                }
              >
                <Trash2 size={16} />
              </Button>
            )}
            {!!row.key && (
              <EnvExplanation
                definition={definition}
                missing={!readOnly && required && !row.value.trim()}
              />
            )}
            {!readOnly &&
              (row.interpolate || (shown && row.value.includes('$'))) && (
                <label className="environment-interpolation">
                  <input
                    type="checkbox"
                    checked={row.interpolate}
                    onChange={(e) =>
                      change(row.id, { interpolate: e.target.checked })
                    }
                  />
                  Подставлять значения других переменных через $VAR
                </label>
              )}
          </div>
        );
      })}
      {!document.rows.length && (
        <p className="muted">Переменные пока не добавлены.</p>
      )}
      {(validation || importError) && (
        <p className="form-error" role="alert">
          {importError || validation}
        </p>
      )}
      {!readOnly && (
        <>
          <div className="environment-toolbar">
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                onChange({
                  ...document,
                  rows: [
                    ...document.rows,
                    {
                      id: crypto.randomUUID(),
                      key: '',
                      value: '',
                      interpolate: false,
                    },
                  ],
                })
              }
            >
              <Plus size={16} /> Добавить переменную
            </Button>
            <label className="environment-import">
              <Upload size={16} /> Импорт .env
              <input
                type="file"
                aria-label="Импортировать переменные из .env"
                onChange={async (event) => {
                  const input = event.currentTarget;
                  const file = input.files?.[0];
                  if (!file) return;
                  try {
                    if (file.size >= 65536)
                      throw new Error('Файл .env должен быть меньше 64 КБ');
                    const parsed = parseEnvDocument(await file.text());
                    setVisible(new Set());
                    onChange(parsed);
                    setImportError('');
                  } catch (error) {
                    setImportError((error as Error).message);
                  } finally {
                    input.value = '';
                  }
                }}
              />
            </label>
          </div>
          <p className="env-hint">
            Импорт заменяет список в редакторе. Изменения применятся после
            сохранения.
          </p>
        </>
      )}
    </fieldset>
  );
}

export function EnvRequirement({ definition }: { definition: EnvDefinition }) {
  return (
    <span
      className={`env-requirement-badge env-requirement-${definition.required === true ? 'required' : definition.required === false ? 'optional' : 'unknown'}`}
    >
      {definition.required === true
        ? 'Обязательная'
        : definition.required === false
          ? 'Необязательная'
          : 'Не определено'}
    </span>
  );
}
export function EnvExplanation({
  definition,
  missing = false,
}: {
  definition: EnvDefinition;
  missing?: boolean;
}) {
  return (
    <div className="env-explanation">
      {definition.description && <p>{definition.description}</p>}
      {missing && (
        <p className="env-missing-text">Заполните перед развёртыванием.</p>
      )}
      {definition.required === false && (
        <p>
          {definition.defaultValue !== undefined ? (
            <>
              Если не заполнять, по умолчанию:{' '}
              <code>{definition.defaultValue || '(пустое значение)'}</code>.
            </>
          ) : (
            'Можно не заполнять. Приложение применит настройки по умолчанию или отключит необязательную функцию.'
          )}
        </p>
      )}
      {definition.required === null && (
        <p>
          Обязательность пока не проверена. Уточните её через анализ проекта или
          чат.
        </p>
      )}
    </div>
  );
}
