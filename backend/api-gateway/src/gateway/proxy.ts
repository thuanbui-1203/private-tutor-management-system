import {
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';

/** Headers that describe one hop and must not be forwarded (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

export function sendJson(
  res: ServerResponse,
  status: number,
  body: object,
  headers: OutgoingHttpHeaders = {},
) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Streams the request to `target + path` and the response back. Request and
 * response bodies are piped, never buffered (the gateway runs without a body parser).
 */
export function forward(
  req: IncomingMessage,
  res: ServerResponse,
  target: string,
  path: string,
  headers: OutgoingHttpHeaders,
  responseHeaders: OutgoingHttpHeaders,
): void {
  const url = new URL(target);
  const outgoing: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) outgoing[name] = value;
  }

  const upstream = httpRequest(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      method: req.method,
      path,
      headers: outgoing,
      timeout: 30_000,
    },
    (response) => {
      const passed: OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (!HOP_BY_HOP.has(name) && value !== undefined) passed[name] = value;
      }
      res.writeHead(response.statusCode ?? 502, { ...passed, ...responseHeaders });
      response.pipe(res);
    },
  );
  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', (err) => {
    if (res.headersSent) return void res.destroy(err);
    const timedOut = err.message === 'upstream timeout';
    sendJson(
      res,
      timedOut ? 504 : 502,
      { statusCode: timedOut ? 504 : 502, message: 'the service is unavailable, try again later' },
      responseHeaders,
    );
  });
  req.pipe(upstream);
}
