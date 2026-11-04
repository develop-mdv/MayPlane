'use client';
import { useState } from 'react';
import {
  Cpu,
  MemoryStick,
  HardDrive,
  Network,
  ArrowDown,
  ArrowUp,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import type { Server } from '@/lib/domain';
import {
  formatBytes,
  formatRate,
  resourceSummary,
} from '@/lib/machine-metrics.mjs';
import { networkRates } from '@/lib/network-metrics.mjs';
import { useNow } from '@/lib/use-now';

type Sample = NonNullable<Server['history']>[number];
const time = (at: string | number) =>
  new Date(at).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
const preciseTime = (at: string) =>
  new Date(at).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
const percent = (v: number | null | undefined) =>
  v == null
    ? '—'
    : `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(v)}%`;
const resources = [
  { kind: 'cpu', label: 'Процессор', icon: Cpu, color: '#95d5b2' },
  { kind: 'memory', label: 'Память', icon: MemoryStick, color: '#b3acf2' },
  { kind: 'disk', label: 'Диск', icon: HardDrive, color: '#e3bf89' },
] as const;

function ResourceCard({
  machine,
  history,
  resource,
}: {
  machine: Server;
  history: Sample[];
  resource: (typeof resources)[number];
}) {
  const { kind, label, icon: Icon, color } = resource;
  const free = kind === 'cpu' ? null : machine[`${kind}AvailableBytes`];
  const hasHistory = history.filter((h) => h[kind] != null).length > 1;
  return (
    <section className="resource-card" aria-label={label}>
      <header>
        <span>
          <Icon size={15} />
          {label}
        </span>
        <b style={{ color }}>{percent(machine[kind])}</b>
      </header>
      <strong className="resource-capacity">
        {resourceSummary(machine, kind)}
      </strong>
      <div className="resource-chart">
        {hasHistory ? (
          <ResponsiveContainer width="100%" height={135} minWidth={0}>
            <AreaChart
              aria-label={`${label}: история измерений`}
              data={history.map((sample) => ({
                ...sample,
                timestamp: Date.parse(sample.at),
              }))}
              accessibilityLayer
              margin={{ top: 12, right: 14, bottom: 0, left: 0 }}
            >
              <defs>
                <linearGradient
                  id={`resource-${kind}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor={color} stopOpacity={0.24} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.01} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#ffffff0c" vertical={false} />
              <XAxis
                dataKey="timestamp"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={time}
                minTickGap={45}
                tick={{ fontSize: 9, fill: '#8b9d91' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={[0, 100]}
                ticks={[0, 50, 100]}
                tickFormatter={(v: number) => `${v}%`}
                width={37}
                tick={{ fontSize: 9, fill: '#8b9d91' }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                isAnimationActive={false}
                content={({ active, payload }) => {
                  const sample = payload?.[0]?.payload as Sample | undefined;
                  return active && sample ? (
                    <div className="metric-tooltip">
                      <time>{preciseTime(sample.at)}</time>
                      <b style={{ color }}>
                        {label} · {percent(sample[kind])}
                      </b>
                      <span>{resourceSummary(sample, kind)}</span>
                      {kind !== 'cpu' &&
                        sample[`${kind}AvailableBytes`] != null && (
                          <span>
                            Доступно{' '}
                            {formatBytes(sample[`${kind}AvailableBytes`])}
                          </span>
                        )}
                    </div>
                  ) : null;
                }}
              />
              <Area
                type="linear"
                dataKey={kind}
                stroke={color}
                fill={`url(#resource-${kind})`}
                strokeWidth={2}
                isAnimationActive={false}
                connectNulls={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: '#202824' }}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="metric-empty">
            {history.length
              ? 'Накапливаем измерения'
              : 'Нет измерений за этот период'}
          </div>
        )}
      </div>
      <footer>
        {kind === 'cpu'
          ? 'Загрузка всех доступных ядер'
          : free == null
            ? 'Доступный объём не передан'
            : `Доступно ${formatBytes(free)}`}
      </footer>
    </section>
  );
}

function NetworkCard({
  machine,
  history,
}: {
  machine: Server;
  history: Sample[];
}) {
  const [visible, setVisible] = useState({ rx: true, tx: true });
  const rates = networkRates(history).map((rate, index) => ({
    ...rate,
    at: history[index + 1].at,
    timestamp: Date.parse(history[index + 1].at),
  }));
  const latest = networkRates(machine.history || []).at(-1);
  return (
    <section className="resource-card network-resource" aria-label="Сеть">
      <header>
        <span>
          <Network size={15} />
          Сеть
        </span>
        <small>в секунду</small>
      </header>
      <div className="network-current">
        <span>
          <ArrowDown size={13} />
          <strong>{formatRate(latest?.rx)}</strong>
        </span>
        <span>
          <ArrowUp size={13} />
          <strong>{formatRate(latest?.tx)}</strong>
        </span>
      </div>
      <div className="resource-chart">
        {rates.some((r) => r.rx != null || r.tx != null) ? (
          <ResponsiveContainer width="100%" height={135} minWidth={0}>
            <LineChart
              aria-label="Скорость сети: история измерений"
              data={rates}
              accessibilityLayer
              margin={{ top: 12, right: 14, bottom: 0, left: 0 }}
            >
              <CartesianGrid stroke="#ffffff0c" vertical={false} />
              <XAxis
                dataKey="timestamp"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={time}
                minTickGap={45}
                tick={{ fontSize: 9, fill: '#8b9d91' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={(v: number) => formatRate(v)}
                width={60}
                tick={{ fontSize: 8, fill: '#8b9d91' }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                isAnimationActive={false}
                content={({ active, payload }) => {
                  const sample = payload?.[0]?.payload as
                    | (typeof rates)[number]
                    | undefined;
                  return active && sample ? (
                    <div className="metric-tooltip">
                      <time>{preciseTime(sample.at)}</time>
                      <span style={{ color: '#83c9c5' }}>
                        ↓ Получено: {formatRate(sample.rx)}
                      </span>
                      <span style={{ color: '#9daed9' }}>
                        ↑ Отправлено: {formatRate(sample.tx)}
                      </span>
                    </div>
                  ) : null;
                }}
              />
              <Line
                type="linear"
                dataKey="rx"
                hide={!visible.rx}
                stroke="#83c9c5"
                dot={false}
                activeDot={{ r: 4 }}
                strokeWidth={2}
                connectNulls={false}
                isAnimationActive={false}
              />
              <Line
                type="linear"
                dataKey="tx"
                hide={!visible.tx}
                stroke="#9daed9"
                dot={false}
                activeDot={{ r: 4 }}
                strokeWidth={2}
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="metric-empty">
            {history.length > 1
              ? 'Скорость сети недоступна'
              : 'Нужны два измерения сети'}
          </div>
        )}
      </div>
      <footer className="network-series">
        {(['rx', 'tx'] as const).map((name) => (
          <button
            type="button"
            key={name}
            aria-pressed={visible[name]}
            onClick={() =>
              setVisible((v) =>
                !v[name === 'rx' ? 'tx' : 'rx']
                  ? v
                  : { ...v, [name]: !v[name] },
              )
            }
          >
            {name === 'rx' ? '↓ Входящий' : '↑ Исходящий'}
          </button>
        ))}
      </footer>
    </section>
  );
}

export function MachineMetrics({ machine }: { machine: Server }) {
  const [period, setPeriod] = useState(15);
  const now = useNow(10000);
  const all = machine.history || [];
  const history = period
    ? all.filter((s) => Date.parse(s.at) >= now - period * 60000)
    : all;
  const live =
    ['online', 'needs_setup'].includes(machine.status) &&
    !!machine.checkedAt &&
    now - Date.parse(machine.checkedAt) < 45000;
  const measuredAt = all.at(-1)?.at || machine.checkedAt;
  return (
    <>
      <div className="metrics-heading resource-heading">
        <div>
          <h2>Состояние машины</h2>
          <span>
            {live && <i className="live-dot" />}
            {live
              ? 'Обновление каждые 10 секунд'
              : 'Последние полученные данные'}
            {measuredAt && ` · ${preciseTime(measuredAt)}`}
          </span>
        </div>
        <fieldset className="metric-period" aria-label="Период графиков">
          {[
            { value: 5, label: '5 мин' },
            { value: 15, label: '15 мин' },
            { value: 0, label: 'Все замеры' },
          ].map((p) => (
            <button
              type="button"
              key={p.value}
              aria-pressed={period === p.value}
              onClick={() => setPeriod(p.value)}
            >
              {p.label}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="metrics-grid resource-grid">
        {resources.map((resource) => (
          <ResourceCard
            key={resource.kind}
            machine={machine}
            history={history}
            resource={resource}
          />
        ))}
        <NetworkCard machine={machine} history={history} />
      </div>
      <p className="metrics-help">
        Точные значения — при наведении, касании или стрелками на графике.
        Пропуски означают отсутствие измерений.
      </p>
    </>
  );
}
