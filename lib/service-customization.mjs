const header = '[[MAYPLANE_SERVICE_CUSTOMIZATION]]\n';
const boundary = '\n[[/MAYPLANE_SERVICE_CUSTOMIZATION]]\n';

export function serviceLinkUrl(value) {
  if (
    typeof value !== 'string' ||
    value.length > 1600 ||
    !/^https?:\/\//i.test(value) ||
    /\s/.test(value)
  )
    return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : '';
  } catch {
    return '';
  }
}

export function serviceFieldLink(field) {
  if (field.type === 'link') {
    const url = serviceLinkUrl(field.url);
    return url ? { url, label: field.value || 'Открыть' } : null;
  }
  if (field.type && field.type !== 'text') return null;
  const value = field.value.trim();
  const markdown = /^\[([^\]\r\n]+)\]\((\S+)\)$/.exec(value);
  const url = serviceLinkUrl(markdown?.[2] || value);
  return url ? { url, label: markdown?.[1] || value } : null;
}

export function allServiceMetrics(configuration) {
  return [
    ...(configuration?.metrics || []),
    ...(configuration?.sections || []).flatMap(
      (section) => section.metrics || [],
    ),
  ];
}

export function serviceMetricKey(metric) {
  if (metric.source === 'runtime') return 'runtime:' + metric.path;
  return metric.url ? `${metric.url}#${metric.path}` : metric.path;
}

export function serviceCustomizationInput(instructions, message) {
  return header + instructions + boundary + message;
}

export function unwrapServiceCustomizationInput(message) {
  if (!message.startsWith(header)) return null;
  const end = message.indexOf(boundary, header.length);
  return end < 0 ? null : message.slice(end + boundary.length);
}

export function serviceCustomizationBlock(text) {
  const open =
    /(?:^|\r?\n)[ \t]*```mayplane-service-config[ \t]*(?:\r?\n|$)/i.exec(text);
  if (!open) return null;
  const after = text.slice(open.index + open[0].length);
  const close = /\r?\n[ \t]*```[ \t]*(?=\r?\n|$)/.exec(after);
  return {
    text: [
      text.slice(0, open.index).trimEnd(),
      close ? after.slice(close.index + close[0].length).trimStart() : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    json: close && close.index <= 64000 ? after.slice(0, close.index) : null,
  };
}
