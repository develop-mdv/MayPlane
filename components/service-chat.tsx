'use client';

import { useState } from 'react';
import {
  ArrowUpRight,
  Boxes,
  Check,
  LoaderCircle,
  MessageSquare,
  X,
} from 'lucide-react';
import type { Hub, ServiceConversationBatch } from '@/lib/hub';
import { serviceChatCommand } from '@/lib/service-chat.mjs';
import { ErrorText } from './hub-ui';
import { serviceSourceLabel, serviceSourceNames } from './service-form';

export function ServiceCommandTag({ onRemove }: { onRemove?: () => void }) {
  return (
    <span className="chat-command-token">
      <Boxes size={13} aria-hidden />
      <code>{serviceChatCommand}</code>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={'Убрать команду ' + serviceChatCommand}
        >
          <X size={13} aria-hidden />
        </button>
      )}
    </span>
  );
}

export function ServiceCommandSuggestion({
  id,
  available,
  onSelect,
}: {
  id: string;
  available: boolean;
  onSelect: () => void;
}) {
  // The composer owns keyboard focus and points to this styled option.
  /* oxlint-disable jsx-a11y/prefer-tag-over-role */
  return (
    <div
      className="composer-command-picker"
      id={id}
      role="listbox"
      aria-label="Команды чата"
    >
      <button
        type="button"
        id={id + '-services'}
        className="composer-command-option"
        role="option"
        aria-selected="true"
        tabIndex={-1}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onSelect}
      >
        <Boxes size={17} aria-hidden />
        <span>
          <strong>
            <code>{serviceChatCommand}</code> Оформить сервисы
          </strong>
          <small>
            {available
              ? 'Осмотр машины и черновики карточек в этом чате'
              : 'Требуется обновление серверной части MayPlane'}
          </small>
        </span>
        <kbd aria-hidden>Tab</kbd>
      </button>
    </div>
  );
  /* oxlint-enable jsx-a11y/prefer-tag-over-role */
}

export function ServiceChatBatch({
  batch,
  hub,
  sessionId,
  disabled,
  onRefresh,
  onOpen,
  onRefine,
}: {
  batch: ServiceConversationBatch;
  hub: Hub;
  sessionId: string;
  disabled: boolean;
  onRefresh: () => Promise<void>;
  onOpen: (id: string) => void;
  onRefine: () => void;
}) {
  const [excluded, setExcluded] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = batch.cards.filter((card) => !card.result);
  const selected = pending.filter((card) => !excluded.includes(card.id));
  const canSave = pending.length > 0 && !batch.replaced;
  async function save() {
    if (!selected.length || saving || disabled || !canSave) return;
    setSaving(true);
    setError('');
    try {
      await hub.api(
        '/hub/sessions/' + sessionId + '/service-drafts/' + batch.id + '/save',
        'POST',
        {
          ids: selected.map((card) => card.id),
        },
      );
      await Promise.all([onRefresh(), hub.refresh()]);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="chat-service-batch" aria-label="Черновики сервисов">
      <div className="chat-service-batch-heading">
        <Boxes size={17} />
        <strong>
          {batch.cards.length ? 'Карточки сервисов' : 'Оформление сервисов'}
        </strong>
        {!!batch.cards.length && <span>{batch.cards.length}</span>}
      </div>
      {batch.replaced && (
        <p className="hub-note">
          Агент предложил новые карточки в более позднем ответе.
        </p>
      )}
      {batch.warnings.map((warning) => (
        <p className="hub-note" key={warning}>
          {warning}
        </p>
      ))}
      {batch.cards.map(({ id, fields, result }) => {
        const project = hub.data.projects.find(
          (item) => item.id === fields.projectId,
        );
        const sources =
          fields.source.type === 'manual'
            ? []
            : [fields.source, ...(fields.additionalSources || [])];
        return (
          <div className="chat-service-card" key={id}>
            <div className="chat-service-card-heading">
              {canSave && !result ? (
                <label>
                  <input
                    type="checkbox"
                    checked={!excluded.includes(id)}
                    disabled={saving || disabled}
                    onChange={(event) =>
                      setExcluded((items) =>
                        event.target.checked
                          ? items.filter((item) => item !== id)
                          : [...items, id],
                      )
                    }
                  />
                  <strong>{fields.name}</strong>
                </label>
              ) : (
                <strong>{fields.name}</strong>
              )}
              {result && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onOpen(result.serviceId)}
                >
                  <Check size={13} />{' '}
                  {result.existing ? 'Уже в сервисах' : 'Открыть сервис'}{' '}
                  <ArrowUpRight size={12} />
                </button>
              )}
            </div>
            {fields.description && <p>{fields.description}</p>}
            <div className="chat-service-card-meta">
              <span>{project?.name || 'Без проекта'}</span>
              {fields.environment && <span>{fields.environment}</span>}
              {fields.directory && <code>{fields.directory}</code>}
              {!sources.length && <span>Ручная карточка</span>}
            </div>
            {!!sources.length && (
              <ul className="chat-service-sources">
                {sources.map((source) => (
                  <li key={JSON.stringify(source)}>
                    <span>{serviceSourceNames[source.type]}</span>{' '}
                    <code>{serviceSourceLabel(source)}</code>
                  </li>
                ))}
              </ul>
            )}
            {(fields.repo || fields.url || fields.notes) && (
              <details className="chat-service-more">
                <summary>Заметки и ссылки</summary>
                {fields.repo && (
                  <a href={fields.repo} target="_blank" rel="noreferrer">
                    Репозиторий <ArrowUpRight size={11} />
                  </a>
                )}
                {fields.url && (
                  <a href={fields.url} target="_blank" rel="noreferrer">
                    Приложение <ArrowUpRight size={11} />
                  </a>
                )}
                {fields.notes && <p>{fields.notes}</p>}
              </details>
            )}
          </div>
        );
      })}
      <ErrorText error={error} />
      {!batch.replaced && (canSave || !!batch.warnings.length) && (
        <div className="chat-service-actions">
          <button
            type="button"
            className="hub-button"
            disabled={saving || disabled}
            onClick={onRefine}
          >
            <MessageSquare size={14} /> Уточнить в чате
          </button>
          {canSave && (
            <button
              type="button"
              className="hub-button primary"
              disabled={saving || disabled || !selected.length}
              onClick={() => void save()}
            >
              {saving ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Check size={14} />
              )}
              Сохранить выбранное
            </button>
          )}
        </div>
      )}
    </section>
  );
}
