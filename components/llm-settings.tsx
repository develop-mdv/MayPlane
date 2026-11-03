'use client';
import { useState } from 'react';
import {
  Sparkles,
  Check,
  RefreshCw,
  Plus,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import type { LlmModel } from '@/lib/domain';
import type { Workspace } from '@/lib/use-workspace';

type Draft = {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  enabled: boolean;
};

const newDraft = (): Draft => ({
  name: 'Gemini 3.8 Flash',
  baseUrl: 'https://api.alltokens.ru/api/v1',
  model: 'google/gemini-3.8-flash',
  apiKey: '',
  enabled: true,
});

export function LlmSettings({ ws }: { ws: Workspace }) {
  return <LlmForm key={ws.data.llm?.updatedAt || 'initial'} ws={ws} />;
}

function LlmForm({ ws }: { ws: Workspace }) {
  const models = ws.data.llm?.models || [];
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(newDraft);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [testingId, setTestingId] = useState('');

  const edit = (model: LlmModel) => {
    setEditingId(model.id);
    setDraft({
      name: model.name,
      baseUrl: model.baseUrl,
      model: model.model,
      apiKey: '',
      enabled: model.enabled,
    });
    setError('');
    setMessage('');
  };

  const add = () => {
    setEditingId('new');
    setDraft(newDraft());
    setError('');
    setMessage('');
  };

  return (
    <section className="git-settings llm-settings">
      <div className="llm-settings-heading">
        <div>
          <h2>
            <Sparkles size={22} /> Модели помощника
          </h2>
          <p>
            Сохраните подключения к OpenAI-совместимым провайдерам, а затем
            выбирайте нужную модель перед отправкой сообщения в чате.
          </p>
        </div>
        <Button type="button" onClick={add} disabled={!!editingId || ws.busy}>
          <Plus size={15} />
          Добавить модель
        </Button>
      </div>

      {!models.length ? (
        <div className="inline-notice">
          Пока нет сохранённых моделей. Добавьте первую модель, чтобы
          пользоваться чатом.
        </div>
      ) : (
        <div className="llm-model-list">
          {models.map((model) => (
            <article className="llm-model-card" key={model.id}>
              <div className="llm-model-summary">
                <div>
                  <strong>{model.name}</strong>
                  <code>{model.model}</code>
                </div>
                <span
                  className={model.enabled ? 'status status-online' : 'status'}
                >
                  {model.enabled ? 'Доступна' : 'Отключена'}
                </span>
              </div>
              <small>{model.baseUrl}</small>
              <div className="llm-model-actions">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!model.enabled || !!testingId || ws.busy}
                  onClick={async () => {
                    setTestingId(model.id);
                    setError('');
                    setMessage('');
                    try {
                      await ws.api('/llm/test', 'POST', {
                        modelId: model.id,
                      });
                      setMessage(`«${model.name}»: подключение работает.`);
                    } catch (err) {
                      setError((err as Error).message);
                    } finally {
                      setTestingId('');
                    }
                  }}
                >
                  <RefreshCw size={14} />
                  {testingId === model.id ? 'Проверяем…' : 'Проверить'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => edit(model)}
                  disabled={!!editingId || ws.busy}
                >
                  <Pencil size={14} />
                  Изменить
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={!!editingId || ws.busy}
                  onClick={async () => {
                    if (
                      !window.confirm(
                        `Удалить модель «${model.name}» и её сохранённый API-ключ?`,
                      )
                    )
                      return;
                    setError('');
                    setMessage('');
                    try {
                      await ws.action(`/llm/models/${model.id}`, {}, 'DELETE');
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  }}
                >
                  <Trash2 size={14} />
                  Удалить
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}

      {editingId && (
        <form
          className="flow-form llm-model-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setError('');
            setMessage('');
            try {
              const path =
                editingId === 'new'
                  ? '/llm/models'
                  : `/llm/models/${editingId}`;
              await ws.action(
                path,
                {
                  name: draft.name,
                  baseUrl: draft.baseUrl,
                  model: draft.model,
                  apiKey: draft.apiKey,
                  enabled: draft.enabled,
                },
                editingId === 'new' ? 'POST' : 'PATCH',
              );
              setEditingId(null);
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <div className="llm-form-heading">
            <h3>{editingId === 'new' ? 'Новая модель' : 'Изменение модели'}</h3>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Закрыть форму"
              onClick={() => setEditingId(null)}
            >
              <X />
            </Button>
          </div>
          <div className="llm-presets">
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setDraft({
                  name: 'Gemini 3.8 Flash',
                  baseUrl: 'https://api.alltokens.ru/api/v1',
                  model: 'google/gemini-3.8-flash',
                  apiKey: '',
                  enabled: true,
                })
              }
            >
              AllTokens · Gemini 3.8 Flash
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setDraft((value) => ({
                  ...value,
                  name: 'OpenRouter',
                  baseUrl: 'https://openrouter.ai/api/v1',
                  model: '',
                  apiKey: '',
                }))
              }
            >
              OpenRouter
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setDraft((value) => ({
                  ...value,
                  name: '',
                  baseUrl: '',
                  model: '',
                  apiKey: '',
                }))
              }
            >
              Свой провайдер
            </Button>
          </div>
          <label className="form-field" htmlFor="llm-name">
            <span>Название</span>
            <Input
              id="llm-name"
              value={draft.name}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  name: event.target.value,
                }))
              }
              required
              maxLength={80}
              placeholder="Рабочая модель"
            />
          </label>
          <label className="form-field" htmlFor="llm-base">
            <span>Base URL</span>
            <Input
              id="llm-base"
              type="url"
              value={draft.baseUrl}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  baseUrl: event.target.value,
                }))
              }
              required
              placeholder="https://provider.example/v1"
            />
            <small>
              API, совместимый с OpenAI Chat Completions. Без /chat/completions
              в конце. Для локальных моделей разрешён http://localhost.
            </small>
          </label>
          <label className="form-field" htmlFor="llm-model">
            <span>Model ID</span>
            <Input
              id="llm-model"
              value={draft.model}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  model: event.target.value,
                }))
              }
              required
              placeholder="google/gemini-3.8-flash"
            />
          </label>
          <label className="form-field" htmlFor="llm-key">
            <span>API-ключ провайдера</span>
            <Input
              id="llm-key"
              type="password"
              autoComplete="off"
              value={draft.apiKey}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  apiKey: event.target.value,
                }))
              }
              placeholder={
                editingId === 'new'
                  ? 'Введите ключ'
                  : 'Оставьте пустым, чтобы сохранить прежний'
              }
            />
            <small>
              Ключ хранится зашифрованным. При смене адреса провайдера
              потребуется новый ключ.
            </small>
          </label>
          <div className="switch-line">
            <div>
              <strong>Доступна в чате</strong>
              <small>
                Отключённую модель нельзя выбрать для нового сообщения.
              </small>
            </div>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(enabled) =>
                setDraft((value) => ({ ...value, enabled }))
              }
              aria-label="Доступна в чате"
            />
          </div>
          <p className="detail-copy">
            Провайдер получит сообщения чата, очищенный вывод команд, выбранные
            манифесты и инструкции репозитория. Значения .env, SSH- и
            GitHub-доступы не передаются.
          </p>
          <div className="detail-actions">
            <Button
              type="submit"
              className="primary-button"
              disabled={!ws.connection || ws.busy}
            >
              {editingId === 'new' ? 'Сохранить модель' : 'Сохранить изменения'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditingId(null)}
              disabled={ws.busy}
            >
              Отмена
            </Button>
          </div>
        </form>
      )}

      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {message && (
        <output className="form-success">
          <Check size={15} />
          {message}
        </output>
      )}
    </section>
  );
}
