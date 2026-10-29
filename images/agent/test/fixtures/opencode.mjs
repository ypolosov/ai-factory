// Только граница модели: штатный API возвращает заранее заданный результат.
import { createServer } from 'node:http';

createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/global/health') {
    response.end('{}');
  } else if (request.url === '/session') {
    response.end(JSON.stringify({ id: 'fixture' }));
  } else if (request.url === '/session/fixture/message') {
    const result = await fetch(`${process.env.GATEWAY_URL}/test/findings`);
    response.end(JSON.stringify({ info: { structured: await result.json() } }));
  } else {
    response.writeHead(404).end('{}');
  }
}).listen(4096, '127.0.0.1');
