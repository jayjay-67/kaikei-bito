const CACHE_NAME = 'bito-pos-cache-v3';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// インストール時にコア資産をプリキャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Pre-caching offline assets...');
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// アクティベーション時に旧キャッシュをクリーンアップ
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            console.log('[Service Worker] Removing old cache:', name);
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// フェッチ処理: キャッシュ優先、ネットワークフォールバック
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Google Apps Script API や 外部API はキャッシュせずネットワークへ通す
  if (url.origin.includes('script.google.com') || url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch((err) => {
        // オフライン時のAPI呼び出し失敗は呼び出し元のJavaScriptでキャッチして処理
        return Promise.reject(err);
      })
    );
    return;
  }

  // アプリ静的アセット: Cache First with Network Revalidate
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // バックグラウンドで最新を取得して次回用に更新
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, networkResponse);
            });
          }
        }).catch(() => {
          // オフライン時は無視
        });
        return cachedResponse;
      }

      // キャッシュにない場合はネットワークから取得し、キャッシュに追加
      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return networkResponse;
      }).catch((err) => {
        // オフラインかつキャッシュにない場合のフォールバック（HTMLリクエストならindex.htmlを返す）
        if (event.request.headers.get('accept') && event.request.headers.get('accept').includes('text/html')) {
          return caches.match('./index.html');
        }
        throw err;
      });
    })
  );
});
