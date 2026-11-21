/**
 * 美東 資金造成会計アプリ (Bito POS) - 同期エンジン (BitoSync)
 * オフライン時はIndexedDBに蓄積し、オンライン復帰時・定期的にGAS経由でスプレッドシートと双方向同期
 */

// バックエンド Google Apps Script Web App URL (直接埋め込み)
const DEFAULT_GAS_URL = 'https://script.google.com/macros/s/AKfycbybfoitFw6ps5RfU-G3ZAMRZyQUsmohAm4n0ZgGa0QE7G3iWuvIguds5v2qi48LUw/exec';

class BitoSyncEngine {
  constructor() {
    this.isOnline = navigator.onLine;
    this.isSyncing = false;
    this.gasUrl = DEFAULT_GAS_URL;
    this.syncIntervalId = null;
    this.statusListeners = [];
    this.lastSyncTime = null;

    this.init();
  }

  async init() {
    // 最終同期日時の読み込み
    this.lastSyncTime = await window.bitoDB.getSetting('last_sync_time', null);

    // ネットワーク状態監視
    window.addEventListener('online', () => {
      console.log('[BitoSync] Online detected.');
      this.isOnline = true;
      this.notifyStatus();
      this.syncNow(); // オンライン復帰時に即時同期
    });

    window.addEventListener('offline', () => {
      console.log('[BitoSync] Offline detected.');
      this.isOnline = false;
      this.notifyStatus();
    });

    // 定期同期 (30秒ごと)
    this.startAutoSync();
    this.notifyStatus();
  }

  onStatusChange(callback) {
    this.statusListeners.push(callback);
    // 初回発火
    callback(this.getStatus());
  }

  notifyStatus() {
    const status = this.getStatus();
    this.statusListeners.forEach((fn) => {
      try {
        fn(status);
      } catch (e) {
        console.error('[BitoSync] Listener error:', e);
      }
    });
  }

  getStatus() {
    return {
      isOnline: this.isOnline,
      isSyncing: this.isSyncing,
      hasGasUrl: Boolean(this.gasUrl && this.gasUrl.trim() !== ''),
      lastSyncTime: this.lastSyncTime
    };
  }

  setGasUrl(url) {
    this.gasUrl = url.trim();
    window.bitoDB.setSetting('gas_url', this.gasUrl);
    this.notifyStatus();
  }

  startAutoSync(intervalMs = 30000) {
    if (this.syncIntervalId) clearInterval(this.syncIntervalId);
    this.syncIntervalId = setInterval(() => {
      if (this.isOnline && !this.isSyncing) {
        this.syncNow(true); // background silent sync
      }
    }, intervalMs);
  }

  /**
   * 同期処理の実行
   * @param {boolean} silent - trueの場合はUIブロックやアラートなし
   */
  async syncNow(silent = false) {
    if (this.isSyncing) {
      console.log('[BitoSync] Sync already in progress, skipping.');
      return { success: false, reason: 'already_syncing' };
    }

    if (!this.isOnline) {
      console.log('[BitoSync] Currently offline. Operations will remain local.');
      return { success: false, reason: 'offline' };
    }

    if (!this.gasUrl) {
      console.log('[BitoSync] GAS URL not configured. Operating in local-only / demo mode.');
      return { success: false, reason: 'no_gas_url' };
    }

    this.isSyncing = true;
    this.notifyStatus();

    try {
      // 1. 未同期の売上トランザクションを取得
      const unsyncedSales = await window.bitoDB.getUnsyncedSales();
      console.log(`[BitoSync] Found ${unsyncedSales.length} unsynced sales transactions.`);

      // スプレッドシートの Sales シート構造にフラット化
      const salesPayload = [];
      const syncedTxIds = [];

      unsyncedSales.forEach((sale) => {
        syncedTxIds.push(sale.transaction_id);
        sale.items.forEach((item) => {
          salesPayload.push({
            transaction_id: sale.transaction_id,
            timestamp: sale.timestamp,
            product_id: item.product_id,
            quantity: item.quantity,
            total_amount: item.subtotal,
            device_id: sale.device_id || 'unknown'
          });
        });
      });

      // 2. GAS APIへリクエスト送信
      // 売上データがある場合は syncSales、ない場合は商品取得(ping/pull)のみ
      let resData;
      if (salesPayload.length > 0) {
        console.log(`[BitoSync] Uploading ${salesPayload.length} sale rows to GAS...`);
        const response = await fetch(this.gasUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({
            action: 'syncSales',
            sales: salesPayload
          })
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        resData = await response.json();

        if (resData.status === 'success') {
          // ローカルの売上を「同期済み」にマーク
          await window.bitoDB.markSalesSynced(syncedTxIds);
          console.log('[BitoSync] Sales successfully marked as synced in local DB.');
        } else {
          throw new Error(resData.message || 'Server returned error');
        }
      } else {
        // 売上はないが、他端末の最新在庫状況を取得する (PULL)
        const fetchUrl = `${this.gasUrl}${this.gasUrl.includes('?') ? '&' : '?'}action=getProducts&_t=${Date.now()}`;
        const response = await fetch(fetchUrl);
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        resData = await response.json();
      }

      // 3. GASから届いた最新の商品・在庫リストをローカルDBに反映
      if (resData && resData.products && Array.isArray(resData.products)) {
        console.log(`[BitoSync] Updating ${resData.products.length} products from server...`);
        await window.bitoDB.saveProducts(resData.products);
        // 商品在庫更新イベントをアプリ全体へ通知
        window.dispatchEvent(new CustomEvent('bito-products-updated', { detail: resData.products }));
      }

      // 4. 成功ステータス更新
      this.lastSyncTime = new Date().toISOString();
      await window.bitoDB.setSetting('last_sync_time', this.lastSyncTime);

      return {
        success: true,
        syncedCount: salesPayload.length,
        timestamp: this.lastSyncTime
      };
    } catch (err) {
      console.warn('[BitoSync] Sync failed (operating in offline fallback mode):', err.message);
      // ネットワーク到達不能判定
      if (!navigator.onLine) {
        this.isOnline = false;
      }
      return { success: false, reason: 'error', error: err.message };
    } finally {
      this.isSyncing = false;
      this.notifyStatus();
    }
  }

  /**
   * GAS接続テスト (Ping)
   */
  async testConnection(url) {
    const targetUrl = url || this.gasUrl;
    if (!targetUrl) throw new Error('GAS URLが指定されていません。');

    const testUrl = `${targetUrl}${targetUrl.includes('?') ? '&' : '?'}action=ping&_t=${Date.now()}`;
    const res = await fetch(testUrl, { method: 'GET' });
    if (!res.ok) throw new Error(`サーバーエラー: ${res.status}`);
    const data = await res.json();
    return data;
  }
}

// シングルトンエクスポート
window.bitoSync = new BitoSyncEngine();
