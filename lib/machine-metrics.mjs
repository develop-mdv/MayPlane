const finite = (v) =>
  typeof v === 'number' &&
  Number.isFinite(v) &&
  v >= 0 &&
  v <= Number.MAX_SAFE_INTEGER
    ? v
    : null;
const percent = (v) =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.max(0, Math.min(100, v))
    : null;
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const cores = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const units = ['Б', 'КиБ', 'МиБ', 'ГиБ', 'ТиБ', 'ПиБ'];

// Older connectors may send only percentages. Never infer capacities from them.
export function resourceMetrics(input) {
  const result = {
    cpu: percent(input.cpu),
    cpuCores:
      Number.isInteger(input.cpuCores) &&
      input.cpuCores > 0 &&
      input.cpuCores <= 65536
        ? input.cpuCores
        : null,
    memory: percent(input.memory),
    disk: percent(input.disk),
  };
  for (const kind of ['memory', 'disk']) {
    const total = finite(input[`${kind}TotalBytes`]);
    const used = finite(input[`${kind}UsedBytes`]);
    const available = finite(input[`${kind}AvailableBytes`]);
    result[`${kind}TotalBytes`] = total > 0 ? total : null;
    result[`${kind}UsedBytes`] =
      total > 0 && used != null && used <= total ? used : null;
    result[`${kind}AvailableBytes`] =
      total > 0 && available != null && available <= total ? available : null;
    if (result[`${kind}UsedBytes`] != null) result[kind] = (100 * used) / total;
  }
  return result;
}

export function metricSample(metrics) {
  return {
    at: metrics.checkedAt,
    ...resourceMetrics(metrics),
    networkRx: finite(metrics.networkRx),
    networkTx: finite(metrics.networkTx),
    uptime: finite(metrics.uptime),
  };
}

export function formatBytes(bytes) {
  if (finite(bytes) == null) return '—';
  const unit =
    bytes > 0
      ? Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
      : 0;
  return `${number.format(bytes / 1024 ** unit)} ${units[unit]}`;
}

/** @param {number | null | undefined} kibPerSecond */
export function formatRate(kibPerSecond) {
  return finite(kibPerSecond) == null
    ? '—'
    : `${formatBytes(kibPerSecond * 1024)}/с`;
}

/** @param {'cpu' | 'memory' | 'disk'} kind */
export function resourceSummary(metrics, kind) {
  if (kind === 'cpu')
    return metrics.cpuCores > 0 && finite(metrics.cpu) != null
      ? `${cores.format((metrics.cpu * metrics.cpuCores) / 100)} из ${number.format(metrics.cpuCores)} vCPU`
      : 'Количество ядер недоступно';
  const used = finite(metrics[`${kind}UsedBytes`]);
  const total = finite(metrics[`${kind}TotalBytes`]);
  if (used == null || !total) return 'Объём недоступен';
  const unit = Math.min(
    units.length - 1,
    Math.floor(Math.log(total) / Math.log(1024)),
  );
  return `${number.format(used / 1024 ** unit)} из ${number.format(total / 1024 ** unit)} ${units[unit]}`;
}
