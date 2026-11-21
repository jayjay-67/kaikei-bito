/**
 * 美東 資金造成会計アプリ - ローカル開発用Webサーバー & モックGAS API
 * 外部依存ゼロ（Node.js標準モジュールのみ）で起動可能
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

// モック用のインメモリスプレッドシートデータ
const mockDatabase = {
  products: [
    { id: 'P001', name: '焼きそば (特製)', price: 500, initial_stock: 100, current_stock: 100, updated_at: new Date().toISOString() },
    { id: 'P002', name: 'フランクフルト', price: 300, initial_stock: 150, current_stock: 150, updated_at: new Date().toISOString() },
    { id: 'P003', name: 'かき氷 (各種シロップ)', price: 300, initial_stock: 120, current_stock: 120, updated_at: new Date().toISOString() },
    { id: 'P004', name: '冷やしきゅうり・パイン', price: 200, initial_stock: 80, current_stock: 80, updated_at: new Date().toISOString() },
    { id: 'P005', name: '生ビール / 缶ビール', price: 500, initial_stock: 120, current_stock: 120, updated_at: new Date().toISOString() },
    { id: 'P006', name: 'ソフトドリンク (お茶/ジュース)', price: 150, initial_stock: 200, current_stock: 200, updated_at: new Date().toISOString() },
    { id: 'P007', name: 'わたあめ', price: 200, initial_stock: 80, current_stock: 80, updated_at: new Date().toISOString() },
    { id: 'P008', name: '光るおもちゃ / くじ', price: 300, initial_stock: 100, current_stock: 100, updated_at: new Date().toISOString() }
  ],
  sales: []
};

const server = http.createServer((req, res) => {
  // CORSヘッダー
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  // --- 1. モック GAS API (/api/mock-gas) ---
  if (parsedUrl.pathname === '/api/mock-gas') {
    if (req.method === 'GET') {
      const action = parsedUrl.searchParams.get('action') || 'getProducts';
      if (action === 'ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', message: 'Mock GAS API is live' }));
        return;
      }
      if (action === 'getProducts') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', products: mockDatabase.products }));
        return;
      }
      if (action === 'getSales') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', sales: mockDatabase.sales }));
        return;
      }
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          const action = data.action;

          if (action === 'syncSales') {
            const records = data.sales || [];
            let inserted = 0;
            records.forEach(sale => {
              mockDatabase.sales.push(sale);
              inserted++;
              // 在庫減算
              const p = mockDatabase.products.find(prod => prod.id === sale.product_id);
              if (p) {
                p.current_stock = Math.max(0, p.current_stock - sale.quantity);
                p.updated_at = new Date().toISOString();
              }
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              status: 'success',
              syncedCount: inserted,
              products: mockDatabase.products,
              timestamp: new Date().toISOString()
            }));
            return;
          }

          if (action === 'updateProduct') {
            const p = data.product;
            const idx = mockDatabase.products.findIndex(item => item.id === p.id);
            if (idx >= 0) {
              mockDatabase.products[idx] = { ...mockDatabase.products[idx], ...p };
            } else {
              mockDatabase.products.push(p);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'success', products: mockDatabase.products }));
            return;
          }

          if (action === 'deleteProduct') {
            const pId = data.id || (data.product ? data.product.id : null);
            mockDatabase.products = mockDatabase.products.filter(item => item.id !== pId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'success', message: 'Product deleted', products: mockDatabase.products }));
            return;
          }

          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'Unknown action' }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: err.message }));
        }
      });
      return;
    }
  }

  // --- 2. 静的ファイル配信 ---
  let reqPath = parsedUrl.pathname;
  if (reqPath === '/' || reqPath === '') {
    reqPath = '/index.html';
  }

  const filePath = path.join(PUBLIC_DIR, reqPath);

  // パストラバーサル防止
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + reqPath);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Service Worker用の特別なヘッダー
    const headers = { 'Content-Type': contentType };
    if (ext === '.js' && filePath.endsWith('sw.js')) {
      headers['Service-Worker-Allowed'] = '/';
    }

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` 美東 資金造成会計アプリ (Bito POS) サーバー起動中 `);
  console.log(` ローカルURL: http://localhost:${PORT}`);
  console.log(` モックGAS API: http://localhost:${PORT}/api/mock-gas`);
  console.log(`====================================================`);
});
