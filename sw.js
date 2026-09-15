/* VoiceType · Service Worker
 *
 * 策略：网络优先 + 缓存兜底
 *   - 在线时永远拿最新代码，改了立刻生效，不存在「慢一个版本」的问题
 *   - 断网时回退到缓存，界面照常打开
 *
 * 之所以不用 stale-while-revalidate：那样虽然加载最快，但用户会一直
 * 看到上一次发布的版本，必须刷新两次才能拿到新代码，对持续更新的工具来说得不偿失。
 * 应用本身只有 70 多 KB，走网络的代价可以忽略；而语音识别本来就需要联网。
 */

const VERSION = '1.0.4';
const CACHE = `voicetype-shell-v${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
  './icons/icon-maskable-512.png',
];

/* 图标这类不会变的东西，缓存优先，省掉一次往返 */
const IMMUTABLE = /\/icons\//;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 逐个添加：某一个文件 404 不应该让整个缓存安装失败
    await Promise.all(SHELL.map((url) =>
      cache.add(url).catch(() => { /* 单个失败就跳过，不影响其他 */ })
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // 只清理本应用自己的旧版本缓存。
    // 千万不要写成「删掉所有非当前缓存」——transformers-cache 里放的是
    // 用户已经下载好的识别模型（Large 档位有 500 多 MB），
    // 那样写会导致每次版本升级都让用户重新下载一遍模型。
    await Promise.all(
      keys
        .filter((k) => k.startsWith('voicetype-shell-') && k !== CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 图标：缓存优先（内容不变，没必要每次都回源）
  if (IMMUTABLE.test(url.pathname)) {
    event.respondWith((async () => {
      const hit = await caches.match(request);
      if (hit) return hit;
      const res = await fetch(request);
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
      }
      return res;
    })());
    return;
  }

  // 其余（HTML / CSS / JS / manifest）：网络优先，失败回退缓存
  event.respondWith((async () => {
    try {
      // 必须显式 no-cache：裸 fetch(request) 会命中浏览器自己的 HTTP 缓存，
      // 而静态服务器通常只给 Last-Modified、没有 Cache-Control，
      // 浏览器就会用「启发式新鲜度」直接吃缓存 —— 结果是发布新版本后
      // 用户看到的还是旧代码。no-cache 表示「先回源校验」，
      // 没改动就 304，代价接近于零；改动了才重新下载。
      const res = await fetch(request, { cache: 'no-cache' });
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
      }
      return res;
    } catch (_) {
      const hit = await caches.match(request);
      if (hit) return hit;
      // 导航请求兜底到首页，避免离线时白屏
      if (request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return new Response('离线且没有缓存副本', {
        status: 503,
        statusText: 'Offline',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});
