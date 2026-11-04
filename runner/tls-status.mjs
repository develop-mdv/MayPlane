import tls from 'node:tls';
import { isIP } from 'node:net';

export function certificateStatus(
  publicUrl,
  { managed = false, connect = tls.connect } = {},
) {
  if (!publicUrl?.startsWith('https://'))
    return Promise.resolve({ enabled: false, managed: false, state: 'local' });
  const url = new URL(publicUrl),
    hostname = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ enabled: true, managed, ...result });
    };
    const socket = connect({
      host: managed ? '127.0.0.1' : hostname,
      port: Number(url.port || 443),
      ...(isIP(hostname) ? {} : { servername: hostname }),
      rejectUnauthorized: true,
      checkServerIdentity: (_name, certificate) =>
        tls.checkServerIdentity(hostname, certificate),
    });
    socket.setTimeout(8000, () => finish({ state: 'unavailable' }));
    socket.once('error', () => finish({ state: 'unavailable' }));
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate(),
        expiry = Date.parse(cert.valid_to);
      finish(
        Number.isFinite(expiry)
          ? {
              state: expiry - Date.now() < 86400000 ? 'expiring' : 'valid',
              expiresAt: new Date(expiry).toISOString(),
              issuer: String(cert.issuer?.CN || '').slice(0, 160),
            }
          : { state: 'unavailable' },
      );
    });
  });
}
