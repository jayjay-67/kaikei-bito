/**
 * 美東 資金造成会計アプリ (Bito POS) - IndexedDB データストア
 * 完全オフラインでもレジ会計と在庫減算、売上蓄積を行う中核モジュール
 */

const DB_NAME = 'BitoPOS_DB';
const DB_VERSION = 1;

class BitoDatabase {
  constructor() {
    this.db = null;
    this.initPromise = null;
  }

  async init() {
    if (this.db) return this.db;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // 1. Products ストア
        if (!db.objectStoreNames.contains('products')) {
          const prodStore = db.createObjectStore('products', { keyPath: 'id' });
          prodStore.createIndex('name', 'name', { unique: false });
          prodStore.createIndex('updated_at', 'updated_at', { unique: false });
        }

        // 2. Sales ストア
        if (!db.objectStoreNames.contains('sales')) {
          const salesStore = db.createObjectStore('sales', { keyPath: 'transaction_id' });
          salesStore.createIndex('timestamp', 'timestamp', { unique: false });
          salesStore.createIndex('synced', 'synced', { unique: false });
          salesStore.createIndex('device_id', 'device_id', { unique: false });
        }

        // 3. Settings ストア
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      request.onsuccess = async (event) => {
        this.db = event.target.result;
        // 初回チェック: 商品が1件もなければ初期データを投入
        const count = await this.getProductCount();
        if (count === 0) {
          await this.seedInitialProducts();
        }
        resolve(this.db);
      };

      request.onerror = (event) => {
        console.error('[IndexedDB] DB open error:', event.target.error);
        reject(event.target.error);
      };
    });

    return this.initPromise;
  }

  /**
   * 初期サンプル商品のシード投入
   */
  async seedInitialProducts() {
    const defaultProducts = [
      { id: 'P001', name: '焼きそば (特製)', price: 500, initial_stock: 100, current_stock: 100, updated_at: new Date().toISOString() },
      { id: 'P002', name: 'フランクフルト', price: 300, initial_stock: 150, current_stock: 150, updated_at: new Date().toISOString() },
      { id: 'P003', name: 'かき氷 (各種シロップ)', price: 300, initial_stock: 120, current_stock: 120, updated_at: new Date().toISOString() },
      { id: 'P004', name: '冷やしきゅうり・パイン', price: 200, initial_stock: 80, current_stock: 80, updated_at: new Date().toISOString() },
      { id: 'P005', name: '生ビール / 缶ビール', price: 500, initial_stock: 120, current_stock: 120, updated_at: new Date().toISOString() },
      { id: 'P006', name: 'ソフトドリンク (お茶/ジュース)', price: 150, initial_stock: 200, current_stock: 200, updated_at: new Date().toISOString() },
      { id: 'P007', name: 'わたあめ', price: 200, initial_stock: 80, current_stock: 80, updated_at: new Date().toISOString() },
      { id: 'P008', name: '光るおもちゃ / くじ', price: 300, initial_stock: 100, current_stock: 100, updated_at: new Date().toISOString() }
    ];

    for (const p of defaultProducts) {
      await this.upsertProduct(p);
    }
    console.log('[IndexedDB] Initial products seeded.');
  }

  async getProductCount() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('products', 'readonly');
      const store = tx.objectStore('products');
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // --- 商品操作 ---

  async getProducts() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('products', 'readonly');
      const store = tx.objectStore('products');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async getProduct(id) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('products', 'readonly');
      const store = tx.objectStore('products');
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async upsertProduct(product) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('products', 'readwrite');
      const store = tx.objectStore('products');
      const p = {
        ...product,
        price: Number(product.price) || 0,
        initial_stock: Number(product.initial_stock !== undefined ? product.initial_stock : product.current_stock) || 0,
        current_stock: Number(product.current_stock) || 0,
        updated_at: new Date().toISOString()
      };
      const req = store.put(p);
      req.onsuccess = () => resolve(p);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteProduct(id) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('products', 'readwrite');
      const store = tx.objectStore('products');
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async saveProducts(productList, replaceAll = false) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('products', 'readwrite');
      const store = tx.objectStore('products');
      if (replaceAll) {
        store.clear();
      }
      productList.forEach((p) => store.put(p));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  // --- 会計・売上操作 ---

  /**
   * 会計トランザクションをローカルに記録し、在庫を即時減算する（原子操作）
   * @param {Object} saleData
   * {
   *   transaction_id: string,
   *   timestamp: string,
   *   device_id: string,
   *   items: [{ product_id, name, price, quantity, subtotal }],
   *   total_amount: number,
   *   received_amount: number,
   *   change_amount: number,
   *   synced: boolean
   * }
   */
  async recordSale(saleData) {
    await this.init();
    return new Promise((resolve, reject) => {
      // products と sales の両方を1つのトランザクションでアトミックに更新
      const tx = this.db.transaction(['sales', 'products'], 'readwrite');
      const salesStore = tx.objectStore('sales');
      const prodStore = tx.objectStore('products');

      const saleRecord = {
        ...saleData,
        synced: false // 初期状態は未同期
      };

      // 1. 売上を記録
      salesStore.add(saleRecord);

      // 2. カート内の各商品の在庫を減算
      for (const item of saleData.items) {
        const getReq = prodStore.get(item.product_id);
        getReq.onsuccess = () => {
          const product = getReq.result;
          if (product) {
            product.current_stock = Math.max(0, (product.current_stock || 0) - item.quantity);
            product.updated_at = new Date().toISOString();
            prodStore.put(product);
          }
        };
      }

      tx.oncomplete = () => {
        console.log('[IndexedDB] Sale recorded and stock decremented locally:', saleRecord.transaction_id);
        resolve(saleRecord);
      };
      tx.onerror = (e) => {
        console.error('[IndexedDB] Transaction error on recordSale:', tx.error);
        reject(tx.error);
      };
    });
  }

  /**
   * 未同期の売上レコード一覧を取得
   */
  async getUnsyncedSales() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('sales', 'readonly');
      const store = tx.objectStore('sales');
      const req = store.getAll();
      req.onsuccess = () => {
        const all = req.result || [];
        const unsynced = all.filter((s) => s.synced === false);
        resolve(unsynced);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * 指定トランザクションID群を同期済みに更新
   */
  async markSalesSynced(transactionIds) {
    if (!transactionIds || transactionIds.length === 0) return true;
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('sales', 'readwrite');
      const store = tx.objectStore('sales');

      const idSet = new Set(transactionIds);
      const req = store.getAll();

      req.onsuccess = () => {
        const all = req.result || [];
        all.forEach((sale) => {
          if (idSet.has(sale.transaction_id)) {
            sale.synced = true;
            sale.synced_at = new Date().toISOString();
            store.put(sale);
          }
        });
      };

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * 全ての売上履歴を取得（集計・ダッシュボード・CSV用）
   */
  async getAllSales() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('sales', 'readonly');
      const store = tx.objectStore('sales');
      const req = store.getAll();
      req.onsuccess = () => {
        const sales = req.result || [];
        // 日時降順ソート
        sales.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        resolve(sales);
      };
      req.onerror = () => reject(req.error);
    });
  }

  // --- 設定ストア ---

  async getSetting(key, defaultValue = null) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('settings', 'readonly');
      const store = tx.objectStore('settings');
      const req = store.get(key);
      req.onsuccess = () => {
        if (req.result !== undefined) {
          resolve(req.result.value);
        } else {
          resolve(defaultValue);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async setSetting(key, value) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('settings', 'readwrite');
      const store = tx.objectStore('settings');
      const req = store.put({ key, value, updated_at: new Date().toISOString() });
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * 全データ消去（初期化テスト用）
   */
  async clearAll() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['products', 'sales', 'settings'], 'readwrite');
      tx.objectStore('products').clear();
      tx.objectStore('sales').clear();
      tx.objectStore('settings').clear();
      tx.oncomplete = async () => {
        await this.seedInitialProducts();
        resolve(true);
      };
      tx.onerror = () => reject(tx.error);
    });
  }
}

// シングルトンエクスポート
window.bitoDB = new BitoDatabase();
