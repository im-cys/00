import http from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

const server = http.createServer(async (request, response) => {
  if (request.url === '/api/hello') {
    const data = {
      message: '你好，这是后端返回的数据',
      serverTime: new Date().toLocaleString('zh-CN')
    };

    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8'
    });

    response.end(JSON.stringify(data));
    return;
  }
    if (request.url === '/') {
    const html = await readFile(
      new URL('./index.html', import.meta.url)
    );

    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8'
    });

    response.end(html);
    return;
  }

  response.writeHead(404);
  response.end('Page not found');
});

server.listen(port, host, () => {
  console.log(`服务器已经启动：http://localhost:${port}`);
});