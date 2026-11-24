import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';

const certificate = await readFile(process.env.ENTERPRISE_E2E_TLS_CERT ?? '');
const privateKey = await readFile(process.env.ENTERPRISE_E2E_TLS_KEY ?? '');
const destinations = new Map([
  [8443, { host: '127.0.0.1', port: 8081, publicPort: 8443 }],
  [3002, { host: '127.0.0.1', port: 3000, publicPort: 3002 }],
]);

for (const [port, target] of destinations) {
  const handler = (request, response) => {
    const headers = { ...request.headers };
    for (const name of Object.keys(headers)) {
      if (name === 'forwarded' || name.startsWith('x-forwarded-')) delete headers[name];
    }
    headers.host = `localhost:${target.publicPort}`;
    headers['x-forwarded-host'] = `localhost:${target.publicPort}`;
    headers['x-forwarded-proto'] = 'https';
    headers['x-forwarded-port'] = String(target.publicPort);
    headers['x-forwarded-for'] = '127.0.0.1';

    const upstream = http.request(
      {
        host: target.host,
        port: target.port,
        method: request.method,
        path: request.url,
        headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('Upstream unavailable');
    });
    request.pipe(upstream);
  };

  for (const address of ['127.0.0.1', '::1']) {
    https.createServer({ cert: certificate, key: privateKey }, handler).listen(port, address);
  }
}
