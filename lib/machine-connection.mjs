export function connectorEndpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      'Адрес панели не должен содержать пароль, параметры или фрагмент',
    );
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  if (
    url.protocol !== 'wss:' &&
    !(
      url.protocol === 'ws:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
  )
    throw new Error('Для удалённой панели нужен HTTPS/WSS');
  if (!['/', '/api/connector'].includes(url.pathname))
    throw new Error('Укажите корневой адрес панели или /api/connector');
  url.pathname = '/api/connector';
  return url.href;
}

// Use the explicit API origin when the UI and runner are hosted separately.
// Browser origin preserves the public domain/IP and port behind a reverse proxy.
export function automaticConnectorEndpoint({ publicUrl, apiUrl, pageOrigin }) {
  return connectorEndpoint(publicUrl || apiUrl || pageOrigin);
}
