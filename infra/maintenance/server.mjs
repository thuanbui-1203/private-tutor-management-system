// Maintenance page served instead of the app (scripts/vps/maintenance.sh on).
// Every request gets 503: HTML for browsers, JSON for the API. It reads no request data.
import { createServer } from 'node:http';

const page = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Đang bảo trì</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f7f5; --fg: #1d1d1b; --muted: #5f5f5a; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ededea; --muted: #a5a5a0; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    box-sizing: border-box; background: var(--bg); color: var(--fg);
    font: 16px/1.6 system-ui, sans-serif; }
  main { max-width: 32rem; text-align: center; }
  h1 { font-size: 1.6rem; margin: 0 0 .5rem; }
  p { margin: 0; color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>Trang web đang bảo trì</h1>
<p>Chúng tôi đang nâng cấp hệ thống. Vui lòng quay lại sau.</p>
</main>
</body>
</html>`;
const json = JSON.stringify({ statusCode: 503, message: 'Hệ thống đang bảo trì' });

createServer((req, res) => {
  const api = (req.url ?? '').startsWith('/api') || (req.headers.host ?? '').startsWith('api.');
  const body = api ? json : page;
  res.writeHead(503, {
    'content-type': api ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'retry-after': '3600',
    'cache-control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}).listen(8090, '0.0.0.0');
