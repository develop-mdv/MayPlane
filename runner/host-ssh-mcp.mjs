import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export const hostSshMcpName = 'mayplane_ssh';
export const hostSshMcpTokenEnv = 'MAYPLANE_SSH_MCP_BEARER';
const protocolVersions = ['2025-11-25', '2025-06-18', '2025-03-26'];
const maxRequestBytes = 16 * 1024;

export function hostSshAcpServer({ url, token }) {
  return {
    type: 'http',
    name: hostSshMcpName,
    url,
    headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
  };
}

export function createHostSshMcp(tools) {
  const clients = new Map();
  let address,
    listening,
    closed = false;
  const server = createServer(
    { maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 10000 },
    (req, res) => {
      void serve(req, res).catch(() => {
        if (!res.destroyed && !res.headersSent) res.writeHead(400).end();
      });
    },
  );
  server.maxConnections = 96;

  async function serve(req, res) {
    // The MCP broker runs on a different listener from the browser/API proxy.
    if (req.headers.origin !== undefined || req.headers.host !== address)
      return res.writeHead(403).end();
    if (req.url !== '/mcp') return res.writeHead(404).end();
    const client = clients.get(req.headers.authorization);
    if (!client) return res.writeHead(401).end();
    if (req.method !== 'POST')
      return res.writeHead(405, { Allow: 'POST' }).end();
    if (
      !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')
    )
      return res.writeHead(415).end();
    const chunks = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > maxRequestBytes)
        return res.writeHead(413, { Connection: 'close' }).end();
      chunks.push(chunk);
    }
    if (clients.get(req.headers.authorization) !== client)
      return res.writeHead(401).end();
    const message = JSON.parse(Buffer.concat(chunks, size));
    if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string')
      return res.writeHead(400).end();
    const { id, method, params } = message;
    if (id === undefined) {
      if (method === 'notifications/cancelled')
        client.pending.get(params?.requestId)?.abort();
      return res.writeHead(202).end();
    }
    if (
      !(
        Number.isSafeInteger(id) ||
        (typeof id === 'string' && id.length <= 128)
      )
    )
      return res.writeHead(400).end();
    const reply = (body) => {
      if (!res.destroyed)
        res
          .writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          })
          .end(JSON.stringify({ jsonrpc: '2.0', id, ...body }));
    };
    const error = (code, message) => reply({ error: { code, message } });
    if (method === 'initialize')
      return reply({
        result: {
          protocolVersion: protocolVersions.includes(params?.protocolVersion)
            ? params.protocolVersion
            : protocolVersions[0],
          capabilities: { tools: {} },
          serverInfo: { name: hostSshMcpName, version: '1.0.0' },
        },
      });
    if (method === 'ping') return reply({ result: {} });
    if (method === 'tools/list') return reply({ result: { tools } });
    if (method !== 'tools/call') return error(-32601, 'Method not found');
    if (!tools.some(({ name }) => name === params?.name))
      return error(-32602, 'Unknown tool');
    if (client.pending.size >= 4 || client.pending.has(id))
      return error(-32000, 'Too many concurrent calls or duplicate request ID');

    const controller = new AbortController();
    client.pending.set(id, controller);
    const abort = () => controller.abort();
    res.once('close', abort);
    try {
      const result = await client.call(
        params.name,
        params.arguments,
        controller.signal,
      );
      reply({ result });
    } catch {
      reply({
        result: {
          isError: true,
          content: [{ type: 'text', text: 'Операция SSH не завершилась.' }],
        },
      });
    } finally {
      res.off('close', abort);
      client.pending.delete(id);
    }
  }

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        address = `127.0.0.1:${server.address().port}`;
        server.unref();
        if (closed) server.close();
        resolve();
      });
    });
  }

  return {
    async register(call) {
      await (listening ??= listen().catch((error) => {
        listening = null;
        throw error;
      }));
      if (closed) throw new Error('Исполнитель останавливается');
      const token = randomBytes(32).toString('base64url');
      const key = `Bearer ${token}`;
      const client = { pending: new Map(), call };
      clients.set(key, client);
      return {
        url: `http://${address}/mcp`,
        token,
        close() {
          clients.delete(key);
          for (const request of client.pending.values()) request.abort();
        },
      };
    },
    close() {
      closed = true;
      for (const client of clients.values())
        for (const request of client.pending.values()) request.abort();
      clients.clear();
      if (server.listening) server.close();
      server.closeAllConnections();
    },
  };
}
