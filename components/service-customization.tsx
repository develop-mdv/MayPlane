'use client';

import { useState } from 'react';
import { ArrowUpRight, Check, LoaderCircle, Settings2 } from 'lucide-react';
import type {
  Hub,
  ServiceCardField,
  ServiceCardMetric,
  ServiceCardSection,
  ServiceCustomization,
  ServiceCustomizationDraft,
} from '@/lib/hub';
import {
  serviceFieldLink,
  serviceMetricKey,
} from '@/lib/service-customization.mjs';
import { CopyButton, ErrorText } from './hub-ui';

const number = new Intl.NumberFormat('ru', { maximumSignificantDigits: 8 });
const metricText = (value: number, unit: string) =>
  [number.format(value), unit].filter(Boolean).join(' ');

function ServiceFieldValue({ field }: { field: ServiceCardField }) {
  const link = serviceFieldLink(field);
  if (link) {
    return (
      <a
        className="service-widget-link"
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        {link.label} <ArrowUpRight size={12} aria-hidden />
      </a>
    );
  }
  if (field.type === 'badge')
    return (
      <span className="service-widget-badge" data-tone={field.tone}>
        {field.value}
      </span>
    );
  if (field.type === 'code') {
    return (
      <span className="service-widget-code">
        <code>{field.value}</code>
        <CopyButton
          value={field.value}
          label={'Скопировать · ' + field.label}
        />
      </span>
    );
  }
  return (
    <span className={field.type === 'note' ? 'service-widget-note' : undefined}>
      {field.value}
    </span>
  );
}

function ServiceMetricValue({
  metric,
  value,
  source,
  preview,
}: {
  metric: ServiceCardMetric;
  value?: number;
  source: string;
  preview: boolean;
}) {
  const { path, unit, warningAt, criticalAt, alertWhen } = metric;
  const direction = alertWhen === 'below' ? '≤' : '≥';
  const thresholds = [
    warningAt === undefined
      ? ''
      : 'Внимание ' + direction + ' ' + metricText(warningAt, unit),
    criticalAt === undefined
      ? ''
      : 'Критично ' + direction + ' ' + metricText(criticalAt, unit),
  ]
    .filter(Boolean)
    .join(' · ');
  if (preview) {
    return (
      <>
        <code>{path}</code>
        {unit && ' · ' + unit}
        <small>
          {metric.source === 'runtime' ? 'Метрика среды выполнения' : source}
        </small>
        {thresholds && <small>{thresholds}</small>}
      </>
    );
  }
  if (value === undefined || !Number.isFinite(value)) return 'Нет данных';
  const reached = (threshold?: number) =>
    threshold !== undefined &&
    (alertWhen === 'below' ? value <= threshold : value >= threshold);
  const severity = reached(criticalAt)
    ? 'danger'
    : reached(warningAt)
      ? 'warning'
      : undefined;
  return (
    <span className="service-widget-measure" title={thresholds || undefined}>
      {metricText(value, unit)}
      {severity && (
        <span className="service-widget-badge" data-tone={severity}>
          {severity === 'danger' ? 'Критично' : 'Внимание'}
        </span>
      )}
    </span>
  );
}

export function ServiceDashboard({
  configuration,
  values,
  preview = false,
}: {
  configuration?: ServiceCustomization;
  values?: Record<string, number>;
  preview?: boolean;
}) {
  if (!configuration) return null;
  const { fields, metrics, sections = [], metricsUrl } = configuration;
  const groups: (ServiceCardSection & { key: string })[] = [
    { key: 'fields', title: '', layout: 'rows', fields, metrics: [] },
    { key: 'metrics', title: '', layout: 'grid', fields: [], metrics },
    ...sections.map((section) => ({
      ...section,
      key: 'section-' + section.title,
    })),
  ];
  return (
    <div className="service-dashboard">
      {groups
        .filter(
          (group) => group.title || group.fields.length || group.metrics.length,
        )
        .map((group) => (
          <div className="service-widget-group" key={group.key}>
            {group.title && <h3>{group.title}</h3>}
            {group.description && (
              <p className="hub-note">{group.description}</p>
            )}
            {(group.fields.length > 0 || group.metrics.length > 0) && (
              <dl className={'service-widget-list ' + group.layout}>
                {group.fields.map((field) => (
                  <div key={'field-' + field.label}>
                    <dt>{field.label}</dt>
                    <dd>
                      <ServiceFieldValue field={field} />
                    </dd>
                  </div>
                ))}
                {group.metrics.map((metric) => (
                  <div key={'metric-' + metric.label}>
                    <dt>{metric.label}</dt>
                    <dd
                      className={preview ? 'service-widget-preview' : undefined}
                    >
                      <ServiceMetricValue
                        metric={metric}
                        value={values?.[serviceMetricKey(metric)]}
                        source={metric.url || metricsUrl}
                        preview={preview}
                      />
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        ))}
    </div>
  );
}

export function ServiceCustomizationCard({
  draft,
  sessionId,
  hub,
  disabled,
  onRefresh,
  onOpen,
}: {
  draft: ServiceCustomizationDraft;
  sessionId: string;
  hub: Hub;
  disabled: boolean;
  onRefresh: () => Promise<void>;
  onOpen: (id: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const configuration = draft.configuration;
  const removed = [
    ...(draft.removedFields || []),
    ...(draft.removedMetrics || []),
    ...(draft.removedSections || []),
  ];
  const serviceExists = hub.data.services.some(
    (service) => service.id === draft.serviceId,
  );
  async function apply() {
    setSaving(true);
    setError('');
    try {
      await hub.api(
        `/hub/sessions/${sessionId}/service-customizations/${draft.id}/apply`,
        'POST',
        {},
      );
      await Promise.all([hub.refresh(), onRefresh()]);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section
      className="chat-service-batch"
      aria-label="Предложение по настройке сервиса"
    >
      <div className="chat-service-batch-heading">
        <Settings2 size={17} />{' '}
        <strong>{draft.serviceName} · поля и метрики</strong>
      </div>
      {draft.warning && <p className="hub-note">{draft.warning}</p>}
      {draft.replaced && (
        <p className="hub-note">В чате есть более новое предложение.</p>
      )}
      {!serviceExists && <p className="hub-note">Сервис больше не доступен.</p>}
      {configuration && (
        <>
          {!configuration.fields.length &&
            !configuration.metrics.length &&
            !configuration.sections?.length && (
              <p className="hub-note">
                Дополнительных полей и метрик в этой версии нет.
              </p>
            )}
          <ServiceDashboard configuration={configuration} preview />
          {!!removed.length && (
            <p className="hub-note">Будут убраны · {removed.join(', ')}</p>
          )}
        </>
      )}
      <ErrorText error={error} />
      {(draft.appliedAt ||
        (configuration && !draft.replaced && serviceExists)) && (
        <div className="chat-service-actions">
          {draft.appliedAt ? (
            <>
              <span className="hub-note">
                <Check size={14} /> Применено
              </span>
              {serviceExists && (
                <button
                  type="button"
                  className="hub-button"
                  onClick={() => onOpen(draft.serviceId)}
                >
                  Открыть карточку <ArrowUpRight size={14} />
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className="hub-button primary"
              disabled={disabled || saving}
              onClick={() => void apply()}
            >
              {saving ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Check size={14} />
              )}
              Применить к карточке
            </button>
          )}
        </div>
      )}
    </section>
  );
}
