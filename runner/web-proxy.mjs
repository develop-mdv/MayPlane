import { request } from 'node:http';
import { pipeline } from 'node:stream';

export function proxyFrontend(req, res, target) {
  const url = new URL(target);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.protocol !== 'http:'
  )
    throw new Error('Frontend must use loopback HTTP');
  const headers = { ...req.headers };
  for (const name of [
    'cookie',
    'authorization',
    'x-mayplane-csrf',
    'connection',
    'upgrade',
    'proxy-authorization',
  ])
    delete headers[name];
  const upstream = request(
    {
      hostname: url.hostname,
      port: url.port,
      method: req.method,
      path: req.url,
      headers,
      timeout: 30000,
    },
    (response) => {
      res.statusCode = response.statusCode;
      for (const [name, value] of Object.entries(response.headers))
        if (
          value !== undefined &&
          ![
            'set-cookie',
            'connection',
            'transfer-encoding',
            'x-powered-by',
          ].includes(name)
        )
          res.setHeader(name, value);
      pipeline(response, res, () => {});
    },
  );
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(503, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Retry-After': '3',
    });
    res.end('MayPlane запускается. Обновите страницу через несколько секунд.');
  });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
  pipeline(req, upstream, () => {});
}
export function browserSecurityHeaders(
  res,
  { publicUrl = '', development = false } = {},
) {
  const websocketSource = publicUrl.startsWith('https://')
    ? ' ' + publicUrl.replace('https://', 'wss://')
    : '';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  );
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (!development)
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'${websocketSource}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`,
    );
  if (publicUrl.startsWith('https://'))
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}
