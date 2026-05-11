import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:8080/oauth/callback';
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ENV_PATH = path.join(ROOT, '.env');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('错误：.env 里 GOOGLE_CLIENT_ID 或 GOOGLE_CLIENT_SECRET 还没填。');
  console.error('参考 https://console.cloud.google.com/apis/credentials');
  process.exit(1);
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPE);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');

console.log('');
console.log('打开浏览器访问以下链接授权 miaoRadio 读取你的 Google Calendar：');
console.log('');
console.log(authUrl.toString());
console.log('');
console.log('授权后 Google 会自动跳回 localhost:8080，本脚本会接住并把 refresh_token 写入 .env。');
console.log('（按 Ctrl+C 取消）');
console.log('');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== '/oauth/callback') {
    res.writeHead(404).end();
    return;
  }

  const errParam = url.searchParams.get('error');
  if (errParam) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('授权被拒绝: ' + errParam);
    console.error('\n授权失败：', errParam);
    server.close();
    process.exit(1);
  }

  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('missing code');
    return;
  }

  try {
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tok = await tokRes.json();
    if (!tokRes.ok) {
      throw new Error(`token 接口返回 ${tokRes.status}: ${JSON.stringify(tok)}`);
    }
    if (!tok.refresh_token) {
      throw new Error(
        'Google 没返回 refresh_token。通常是因为你之前已经授权过 miaoRadio。\n' +
        '解决：到 https://myaccount.google.com/permissions 找到 miaoRadio 移除，再重跑本脚本。',
      );
    }

    await upsertEnvKey('GOOGLE_REFRESH_TOKEN', tok.refresh_token);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset=utf-8>
      <title>授权成功</title>
      <body style="font-family:-apple-system,sans-serif;background:#0d0e10;color:#e6e6e6;padding:60px;text-align:center">
        <h2 style="color:#ff7a45">授权成功</h2>
        <p>refresh_token 已写入 .env，可以关掉这个窗口回到终端了。</p>
      </body>`);

    console.log('\n成功：refresh_token 已写入 .env');
    console.log('现在可以正常启动：npm run dev\n');
    server.close();
    setTimeout(() => process.exit(0), 50);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('交换 token 失败: ' + e.message);
    console.error('\n交换 token 失败：', e.message);
    server.close();
    process.exit(1);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('\n端口 8080 被占用——先停掉 npm run dev 再跑本脚本。');
    process.exit(1);
  }
  throw e;
});

server.listen(8080);

async function upsertEnvKey(key, value) {
  const line = `${key}=${value}`;
  let text = '';
  try { text = await fs.readFile(ENV_PATH, 'utf-8'); } catch {}
  const re = new RegExp(`^${key}=.*$`, 'm');
  const updated = re.test(text)
    ? text.replace(re, line)
    : (text.trimEnd() + '\n' + line + '\n').replace(/^\n+/, '');
  await fs.writeFile(ENV_PATH, updated);
}
