/**
 * 美東 資金造成会計アプリ (Bito POS) - メインアプリケーション制御 (BitoApp)
 * 片手操作に最適化したレジ機能、カート計算、担当者切り替え、在庫切れ防止
 */

class BitoApp {
  constructor() {
    this.cart = {}; // { productId: quantity }
    this.products = [];
    this.currentDeviceId = 'メイン担当1';
    this.activeTab = 'cashier'; // cashier | stock | dashboard | settings

    this.init();
  }

  async init() {
    // 担当者の復帰
    this.currentDeviceId = await window.bitoDB.getSetting('device_id', 'メイン担当1');
    const deviceSelect = document.getElementById('device-select');
    if (deviceSelect) deviceSelect.value = this.currentDeviceId;

    // 商品マスターの読み込み
    await this.refreshProducts();

    // イベントバインド
    this.bindEvents();

    // 通信ステータス監視
    window.bitoSync.onStatusChange((status) => this.updateSyncIndicator(status));

    // サーバーからの在庫更新イベント購読
    window.addEventListener('bito-products-updated', (e) => {
      this.products = e.detail;
      this.renderProductGrid();
      this.renderStockList();
    });

    // 初回レンダリング
    this.renderProductGrid();
    this.updateCartUI();
    this.updateUnsyncedBadge();

    // 初期タブを確実に表示 (Service Worker キャッシュや CDN 遅延対策)
    this.switchTab(this.activeTab);

    // サービスワーカーの登録
    this.registerServiceWorker();
  }

  /**
   * 商品データの再取得
   */
  async refreshProducts() {
    this.products = await window.bitoDB.getProducts();
    return this.products;
  }

  /**
   * Service Worker登録
   */
  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
          .then((reg) => console.log('[PWA] Service Worker registered:', reg.scope))
          .catch((err) => console.warn('[PWA] Service Worker registration failed:', err));
      });
    }
  }

  /**
   * 各種イベントリスナー登録
   */
  bindEvents() {
    // 担当者変更
    const devSelect = document.getElementById('device-select');
    if (devSelect) {
      devSelect.addEventListener('change', async (e) => {
        this.currentDeviceId = e.target.value;
        await window.bitoDB.setSetting('device_id', this.currentDeviceId);
        this.showToast(`担当者を「${this.currentDeviceId}」に切り替えました`);
      });
    }

    // タブ切り替え
    document.querySelectorAll('[data-tab-target]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const tab = btn.getAttribute('data-tab-target');
        this.switchTab(tab);
      });
    });

    // カートクリアボタン
    const clearCartBtn = document.getElementById('btn-clear-cart');
    if (clearCartBtn) {
      clearCartBtn.addEventListener('click', () => {
        if (Object.keys(this.cart).length === 0) return;
        this.vibrate(30);
        this.cart = {};
        this.updateCartUI();
        this.renderProductGrid();
      });
    }

    // 会計へ進むボタン
    const checkoutBtn = document.getElementById('btn-open-checkout');
    if (checkoutBtn) {
      checkoutBtn.addEventListener('click', () => {
        this.openCheckoutModal();
      });
    }

    // 会計モーダル内クイック金額ボタン
    document.querySelectorAll('[data-quick-amount]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const amt = btn.getAttribute('data-quick-amount');
        this.handleQuickAmount(amt);
      });
    });

    // 会計確定ボタン
    const completeBtn = document.getElementById('btn-complete-payment');
    if (completeBtn) {
      completeBtn.addEventListener('click', () => {
        this.completeCheckout();
      });
    }

    // 完了モーダルの「次へ進む」ボタン
    const finishNextBtn = document.getElementById('btn-finish-next');
    if (finishNextBtn) {
      finishNextBtn.addEventListener('click', () => {
        this.closeModal('modal-success');
      });
    }

    // 手動同期ボタン (設定画面)
    const manualSyncBtn = document.getElementById('btn-manual-sync');
    if (manualSyncBtn) {
      manualSyncBtn.addEventListener('click', async () => {
        this.vibrate(30);
        manualSyncBtn.disabled = true;
        manualSyncBtn.textContent = '同期中...';
        const res = await window.bitoSync.syncNow();
        manualSyncBtn.disabled = false;
        manualSyncBtn.textContent = '今すぐスプレッドシートと同期';

        if (res.success) {
          this.showToast(`同期完了！ (${res.syncedCount}件送信)`);
          await this.refreshProducts();
          this.renderProductGrid();
          this.renderStockList();
          this.updateUnsyncedBadge();
          if (this.activeTab === 'dashboard') window.bitoAdmin.renderDashboard();
        } else {
          this.showToast(`同期未実行: ${res.reason || 'オフラインまたはURL未設定'}`);
        }
      });
    }

    // 接続テストボタン
    const testGasBtn = document.getElementById('btn-test-gas');
    if (testGasBtn) {
      testGasBtn.addEventListener('click', async () => {
        testGasBtn.disabled = true;
        testGasBtn.textContent = 'テスト中...';
        try {
          const res = await window.bitoSync.testConnection();
          alert('接続成功！ API応答: ' + JSON.stringify(res));
        } catch (e) {
          alert('接続失敗: ' + e.message);
        } finally {
          testGasBtn.disabled = false;
          testGasBtn.textContent = '📶 接続テスト (Ping)';
        }
      });
    }

    // CSVエクスポートボタン群
    const csvSalesBtn = document.getElementById('btn-export-sales-csv');
    if (csvSalesBtn) {
      csvSalesBtn.addEventListener('click', () => window.bitoAdmin.exportSalesDetailCsv());
    }

    const csvProductBtn = document.getElementById('btn-export-product-csv');
    if (csvProductBtn) {
      csvProductBtn.addEventListener('click', () => window.bitoAdmin.exportProductSummaryCsv());
    }

    const csvHourlyBtn = document.getElementById('btn-export-hourly-csv');
    if (csvHourlyBtn) {
      csvHourlyBtn.addEventListener('click', () => window.bitoAdmin.exportHourlySummaryCsv());
    }

    // 商品追加フォーム
    const addProdForm = document.getElementById('form-add-product');
    if (addProdForm) {
      addProdForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.handleAddNewProduct();
      });
    }

    // 商品編集フォーム
    const editProdForm = document.getElementById('form-edit-product');
    if (editProdForm) {
      editProdForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.handleEditProductSubmit();
      });
    }

    // 編集モーダル内の削除ボタン
    const deleteProdBtn = document.getElementById('btn-delete-product');
    if (deleteProdBtn) {
      deleteProdBtn.addEventListener('click', async () => {
        const idInput = document.getElementById('edit-prod-id');
        if (idInput && idInput.value) {
          await this.confirmDeleteProduct(idInput.value);
        }
      });
    }

    // 全データリセットボタン (開発・テスト用)
    const resetBtn = document.getElementById('btn-reset-db');
    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        if (confirm('ローカルの全売上と設定をリセットし初期状態に戻しますか？')) {
          await window.bitoDB.clearAll();
          this.cart = {};
          await this.refreshProducts();
          this.renderProductGrid();
          this.updateCartUI();
          this.updateUnsyncedBadge();
          this.showToast('データベースを初期化しました');
        }
      });
    }
  }

  /**
   * タブ切り替え
   */
  async switchTab(tab) {
    this.activeTab = tab;
    this.vibrate(20);

    // ナビボタンのアクティブ表示切替
    document.querySelectorAll('[data-tab-target]').forEach((btn) => {
      const isCurrent = btn.getAttribute('data-tab-target') === tab;
      // Tailwind CDN依存を排除: CSSクラス active を使用
      btn.classList.toggle('active', isCurrent);
      // Tailwindクラスも念のため維持
      btn.classList.toggle('text-sky-400', isCurrent);
      btn.classList.toggle('text-slate-400', !isCurrent);
    });

    // タブパネル表示切替 (style直接制御 + hidden class 両用)
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      const isActive = panel.id === `tab-${tab}`;
      panel.classList.toggle('hidden', !isActive);
      panel.style.display = isActive ? '' : 'none';
    });

    // タブごとのデータ更新
    if (tab === 'cashier') {
      await this.refreshProducts();
      this.renderProductGrid();
    } else if (tab === 'stock') {
      await this.refreshProducts();
      this.renderStockList();
    } else if (tab === 'dashboard') {
      await window.bitoAdmin.renderDashboard();
    } else if (tab === 'settings') {
      this.updateSyncIndicator(window.bitoSync.getStatus());
    }
  }

  /**
   * レジ画面: 商品グリッドの描画 (片手タップ特化UI)
   */
  renderProductGrid() {
    const grid = document.getElementById('product-grid');
    if (!grid) return;
    grid.innerHTML = '';

    this.products.forEach((p) => {
      const inCartQty = this.cart[p.id] || 0;
      const isSoldOut = p.current_stock <= 0;
      const isStockLimit = inCartQty >= p.current_stock;

      const card = document.createElement('button');
      card.type = 'button';
      card.className = `relative flex flex-col justify-between p-3.5 rounded-2xl border text-left transition-all active:scale-95 select-none ${
        isSoldOut
          ? 'bg-slate-900/60 border-slate-800 opacity-50 cursor-not-allowed'
          : inCartQty > 0
            ? 'bg-sky-950/40 border-sky-500 shadow-md shadow-sky-500/10'
            : 'bg-slate-850 bg-slate-800/80 border-slate-700/80 hover:border-slate-600 shadow-sm'
      }`;
      card.style.minHeight = '105px';

      // カート内数量バッジ
      const badgeHtml = inCartQty > 0
        ? `<div class="absolute -top-2 -right-2 w-7 h-7 rounded-full bg-sky-500 text-white font-black text-sm flex items-center justify-center shadow-lg animate-bounce-short">
            ${inCartQty}
          </div>`
        : '';

      // 在庫残数バッジ
      const stockBadge = isSoldOut
        ? `<span class="px-2 py-0.5 text-xs font-bold bg-rose-500 text-white rounded">売り切れ</span>`
        : p.current_stock <= 10
          ? `<span class="px-1.5 py-0.5 text-xs font-semibold bg-amber-500/20 text-amber-300 rounded border border-amber-500/30">残 ${p.current_stock}</span>`
          : `<span class="px-1.5 py-0.5 text-xs font-medium text-slate-400">残 ${p.current_stock}</span>`;

      card.innerHTML = `
        ${badgeHtml}
        <div class="w-full">
          <div class="flex items-start justify-between gap-1 mb-1">
            <span class="font-bold text-base leading-tight text-slate-100">${this.escapeHtml(p.name)}</span>
          </div>
        </div>
        <div class="w-full flex items-end justify-between mt-2 pt-1 border-t border-slate-700/40">
          <span class="text-xl font-extrabold text-sky-400">¥${p.price.toLocaleString()}</span>
          ${stockBadge}
        </div>
      `;

      card.addEventListener('click', () => {
        if (isSoldOut) {
          this.vibrate([80, 50, 80]);
          this.showToast(`「${p.name}」は売り切れです！`);
          return;
        }
        if (isStockLimit) {
          this.vibrate([80, 50, 80]);
          this.showToast(`これ以上の在庫がありません (残 ${p.current_stock}点)`);
          return;
        }

        this.addToCart(p.id);
      });

      grid.appendChild(card);
    });
  }

  /**
   * カートへの追加
   */
  addToCart(productId) {
    this.vibrate(25);
    this.cart[productId] = (this.cart[productId] || 0) + 1;
    this.updateCartUI();
    this.renderProductGrid();
  }

  /**
   * カート内商品の数量変更
   */
  changeCartQty(productId, delta) {
    this.vibrate(20);
    const current = this.cart[productId] || 0;
    const target = current + delta;
    const product = this.products.find((p) => p.id === productId);

    if (target <= 0) {
      delete this.cart[productId];
    } else {
      if (product && target > product.current_stock) {
        this.showToast(`在庫上限です (残 ${product.current_stock}点)`);
        return;
      }
      this.cart[productId] = target;
    }
    this.updateCartUI();
    this.renderProductGrid();
  }

  /**
   * カートUIの再計算・更新
   */
  updateCartUI() {
    let totalQty = 0;
    let totalPrice = 0;
    const items = [];

    for (const [pId, qty] of Object.entries(this.cart)) {
      const p = this.products.find((prod) => prod.id === pId);
      if (p) {
        totalQty += qty;
        totalPrice += p.price * qty;
        items.push({ ...p, quantity: qty, subtotal: p.price * qty });
      }
    }

    // 下部バーの表示更新
    const elCartQty = document.getElementById('bar-cart-qty');
    const elCartTotal = document.getElementById('bar-cart-total');
    const btnCheckout = document.getElementById('btn-open-checkout');
    const btnClear = document.getElementById('btn-clear-cart');

    if (elCartQty) elCartQty.textContent = `${totalQty}点`;
    if (elCartTotal) elCartTotal.textContent = `¥${totalPrice.toLocaleString()}`;

    if (btnCheckout) {
      btnCheckout.disabled = totalQty === 0;
      btnCheckout.classList.toggle('opacity-50', totalQty === 0);
      btnCheckout.classList.toggle('cursor-not-allowed', totalQty === 0);
    }
    if (btnClear) {
      btnClear.disabled = totalQty === 0;
      btnClear.classList.toggle('opacity-40', totalQty === 0);
    }

    // カート明細リスト (モーダルまたは展開時)
    const listEl = document.getElementById('checkout-items-list');
    if (listEl) {
      listEl.innerHTML = '';
      if (items.length === 0) {
        listEl.innerHTML = '<div class="text-center text-slate-400 py-4">カートは空です</div>';
      } else {
        items.forEach((item) => {
          const row = document.createElement('div');
          row.className = 'flex items-center justify-between py-2 border-b border-slate-700/60 text-sm';
          row.innerHTML = `
            <div class="flex-1">
              <div class="font-bold text-slate-100">${this.escapeHtml(item.name)}</div>
              <div class="text-xs text-slate-400">¥${item.price.toLocaleString()} × ${item.quantity}</div>
            </div>
            <div class="flex items-center gap-2">
              <button class="w-7 h-7 rounded-full bg-slate-700 hover:bg-slate-600 font-bold text-slate-200" onclick="window.bitoApp.changeCartQty('${item.id}', -1)">−</button>
              <span class="w-6 text-center font-bold text-slate-100">${item.quantity}</span>
              <button class="w-7 h-7 rounded-full bg-slate-700 hover:bg-slate-600 font-bold text-slate-200" onclick="window.bitoApp.changeCartQty('${item.id}', 1)">＋</button>
              <div class="w-16 text-right font-bold text-sky-400">¥${item.subtotal.toLocaleString()}</div>
            </div>
          `;
          listEl.appendChild(row);
        });
      }
    }
  }

  /**
   * 会計モーダルを開く
   */
  openCheckoutModal() {
    this.vibrate(30);
    let total = 0;
    for (const [pId, qty] of Object.entries(this.cart)) {
      const p = this.products.find((prod) => prod.id === pId);
      if (p) total += p.price * qty;
    }

    if (total === 0) return;

    this.currentTotal = total;
    this.receivedAmount = total; // 初期値は「ぴったり」

    const modalTotal = document.getElementById('modal-total-amount');
    const inputReceived = document.getElementById('input-received-amount');

    if (modalTotal) modalTotal.textContent = `¥${total.toLocaleString()}`;
    if (inputReceived) inputReceived.value = total;

    this.updateChangeCalculation();
    this.openModal('modal-checkout');
  }

  /**
   * お預かり金額クイックボタンの処理
   */
  handleQuickAmount(val) {
    this.vibrate(20);
    const input = document.getElementById('input-received-amount');
    if (!input) return;

    if (val === 'exact') {
      this.receivedAmount = this.currentTotal;
    } else if (val === 'clear') {
      this.receivedAmount = 0;
    } else {
      const addNum = parseInt(val, 10);
      if (val.startsWith('+')) {
        this.receivedAmount = (this.receivedAmount || 0) + addNum;
      } else {
        this.receivedAmount = addNum;
      }
    }

    input.value = this.receivedAmount;
    this.updateChangeCalculation();
  }

  /**
   * お釣り計算
   */
  updateChangeCalculation() {
    const input = document.getElementById('input-received-amount');
    const changeDisplay = document.getElementById('modal-change-amount');
    const btnComplete = document.getElementById('btn-complete-payment');

    const received = parseInt(input.value, 10) || 0;
    this.receivedAmount = received;
    const diff = received - this.currentTotal;

    if (diff >= 0) {
      changeDisplay.textContent = `¥${diff.toLocaleString()}`;
      changeDisplay.className = 'text-3xl font-black text-emerald-400';
      if (btnComplete) {
        btnComplete.disabled = false;
        btnComplete.classList.remove('opacity-40', 'cursor-not-allowed');
      }
    } else {
      changeDisplay.textContent = `不足 ¥${Math.abs(diff).toLocaleString()}`;
      changeDisplay.className = 'text-3xl font-black text-rose-400 animate-pulse';
      if (btnComplete) {
        btnComplete.disabled = true;
        btnComplete.classList.add('opacity-40', 'cursor-not-allowed');
      }
    }
  }

  /**
   * 会計完了処理 (IndexedDBへ保存 & 在庫減算 & 即時同期トリガー)
   */
  async completeCheckout() {
    if (this.receivedAmount < this.currentTotal) {
      this.showToast('お預かり金額が不足しています');
      return;
    }

    this.vibrate([50, 70, 50]);

    // トランザクションレコード構築
    const now = new Date();
    const txId = 'TX-' + now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14) + '-' + Math.floor(Math.random() * 900 + 100);

    const items = [];
    for (const [pId, qty] of Object.entries(this.cart)) {
      const p = this.products.find((prod) => prod.id === pId);
      if (p) {
        items.push({
          product_id: p.id,
          name: p.name,
          price: p.price,
          quantity: qty,
          subtotal: p.price * qty
        });
      }
    }

    const saleRecord = {
      transaction_id: txId,
      timestamp: now.toISOString(),
      device_id: this.currentDeviceId,
      items: items,
      total_amount: this.currentTotal,
      received_amount: this.receivedAmount,
      change_amount: this.receivedAmount - this.currentTotal
    };

    // 1. IndexedDBに保存 (在庫も減算される)
    await window.bitoDB.recordSale(saleRecord);

    // 2. モーダル切り替え（完了モーダルでお釣りを大表示）
    this.closeModal('modal-checkout');
    const successChange = document.getElementById('success-change-amount');
    const successTotal = document.getElementById('success-total-amount');
    if (successChange) successChange.textContent = `¥${(saleRecord.change_amount).toLocaleString()}`;
    if (successTotal) successTotal.textContent = `¥${(saleRecord.total_amount).toLocaleString()}`;
    this.openModal('modal-success');

    // 3. カートをクリアし、最新在庫を再レンダリング
    this.cart = {};
    await this.refreshProducts();
    this.renderProductGrid();
    this.updateCartUI();
    this.updateUnsyncedBadge();

    // 4. バックグラウンドで同期試行 (通信可能な場合)
    if (window.bitoSync.isOnline) {
      window.bitoSync.syncNow(true).then(() => {
        this.updateUnsyncedBadge();
      });
    }
  }

  /**
   * 在庫管理タブ: 在庫一覧の描画 (項目の編集・削除対応)
   */
  renderStockList() {
    const container = document.getElementById('stock-list-container');
    if (!container) return;
    container.innerHTML = '';

    if (this.products.length === 0) {
      container.innerHTML = `
        <div class="bg-slate-800/60 border border-slate-700/60 rounded-2xl p-8 text-center text-slate-400">
          <div class="text-3xl mb-2">📦</div>
          <div class="text-sm font-bold text-slate-300">商品が登録されていません</div>
          <div class="text-xs text-slate-500 mt-1">下のフォームから商品を追加してください</div>
        </div>
      `;
      return;
    }

    this.products.forEach((p) => {
      const card = document.createElement('div');
      card.className = 'bg-slate-800/80 border border-slate-700/80 rounded-2xl p-3.5 mb-3 shadow-sm hover:border-slate-600 transition-colors';
      card.innerHTML = `
        <div class="flex items-start justify-between gap-2 mb-2">
          <div class="flex-1">
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-mono font-bold bg-slate-900 text-sky-400 px-1.5 py-0.5 rounded border border-slate-700">${p.id}</span>
              <span class="font-bold text-slate-100 text-base leading-snug">${this.escapeHtml(p.name)}</span>
            </div>
            <div class="text-xs text-slate-400 mt-1 flex items-center gap-2">
              <span>単価: <strong class="text-sky-400 font-bold">¥${p.price.toLocaleString()}</strong></span>
              <span class="text-slate-600">|</span>
              <span>初期数: ${p.initial_stock || 0}点</span>
            </div>
          </div>
          <!-- 現在庫バッジ -->
          <div class="text-right">
            <div class="text-[10px] text-slate-400 font-medium">現在庫</div>
            <div class="text-2xl font-black ${p.current_stock <= 0 ? 'text-rose-400' : p.current_stock <= 10 ? 'text-amber-400' : 'text-emerald-400'}">
              ${p.current_stock}
            </div>
          </div>
        </div>

        <!-- クイック補充 & 操作ボタンバー -->
        <div class="flex items-center justify-between pt-2.5 border-t border-slate-700/60 gap-2">
          <div class="flex items-center gap-1.5">
            <span class="text-[11px] text-slate-400 font-medium">補充:</span>
            <button class="px-2.5 py-1 bg-slate-700 hover:bg-slate-600 active:scale-95 rounded-lg text-xs font-bold text-slate-200 transition-transform" onclick="window.bitoApp.addStock('${p.id}', 10)">+10</button>
            <button class="px-2.5 py-1 bg-sky-600 hover:bg-sky-500 active:scale-95 rounded-lg text-xs font-bold text-white transition-transform" onclick="window.bitoApp.addStock('${p.id}', 50)">+50</button>
          </div>

          <div class="flex items-center gap-1.5">
            <button class="px-3 py-1 bg-slate-700/80 hover:bg-slate-600 active:scale-95 rounded-lg text-xs font-bold text-sky-300 border border-slate-600 transition-all flex items-center gap-1" onclick="window.bitoApp.openEditProductModal('${p.id}')">
              <span>✏️</span>
              <span>編集</span>
            </button>
            <button class="px-2.5 py-1 bg-rose-500/10 hover:bg-rose-500/20 active:scale-95 rounded-lg text-xs font-bold text-rose-400 border border-rose-500/30 transition-all" onclick="window.bitoApp.confirmDeleteProduct('${p.id}')">
              <span>🗑️</span>
            </button>
          </div>
        </div>
      `;
      container.appendChild(card);
    });
  }

  /**
   * 商品編集モーダルを開く
   */
  openEditProductModal(productId) {
    this.vibrate(20);
    const p = this.products.find((item) => item.id === productId);
    if (!p) return;

    const idInput = document.getElementById('edit-prod-id');
    const idDisplay = document.getElementById('edit-prod-id-display');
    const nameInput = document.getElementById('edit-prod-name');
    const priceInput = document.getElementById('edit-prod-price');
    const stockInput = document.getElementById('edit-prod-stock');
    const initStockInput = document.getElementById('edit-prod-initial-stock');

    if (idInput) idInput.value = p.id;
    if (idDisplay) idDisplay.textContent = p.id;
    if (nameInput) nameInput.value = p.name;
    if (priceInput) priceInput.value = p.price;
    if (stockInput) stockInput.value = p.current_stock;
    if (initStockInput) initStockInput.value = p.initial_stock !== undefined ? p.initial_stock : p.current_stock;

    this.openModal('modal-edit-product');
  }

  /**
   * 商品編集の保存実行
   */
  async handleEditProductSubmit() {
    this.vibrate(30);
    const id = document.getElementById('edit-prod-id').value;
    const name = document.getElementById('edit-prod-name').value.trim();
    const price = parseInt(document.getElementById('edit-prod-price').value, 10) || 0;
    const currentStock = parseInt(document.getElementById('edit-prod-stock').value, 10) || 0;
    const initialStock = parseInt(document.getElementById('edit-prod-initial-stock').value, 10) || currentStock;

    if (!name || price < 0 || currentStock < 0) {
      alert('商品名、価格、在庫数を正しく入力してください。');
      return;
    }

    const updatedProduct = {
      id: id,
      name: name,
      price: price,
      initial_stock: initialStock,
      current_stock: currentStock,
      updated_at: new Date().toISOString()
    };

    // 1. IndexedDB 更新
    await window.bitoDB.upsertProduct(updatedProduct);

    // 2. カート内の商品情報も同期（価格や名前が変わった場合）
    this.updateCartUI();

    // 3. UI再描画
    this.closeModal('modal-edit-product');
    await this.refreshProducts();
    this.renderStockList();
    this.renderProductGrid();

    this.showToast(`「${name}」の情報を更新しました`);

    // 4. GASへ更新通知（オンライン時）
    if (window.bitoSync.isOnline && window.bitoSync.gasUrl) {
      fetch(window.bitoSync.gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'updateProduct', product: updatedProduct })
      }).catch((e) => console.log('Background product update sync failed:', e));
    }
  }

  /**
   * 商品の削除確認および削除実行
   */
  async confirmDeleteProduct(productId) {
    this.vibrate([40, 60, 40]);
    const p = this.products.find((item) => item.id === productId);
    const prodName = p ? p.name : productId;

    const ok = confirm(`商品「${prodName}」を完全に削除しますか？\n（レジ画面や在庫一覧からも削除されます）`);
    if (!ok) return;

    // 1. IndexedDBから削除
    await window.bitoDB.deleteProduct(productId);

    // 2. カートに入っていたら除去
    if (this.cart[productId]) {
      delete this.cart[productId];
      this.updateCartUI();
    }

    // 3. モーダルが開いていれば閉じる
    this.closeModal('modal-edit-product');

    // 4. UI再描画
    await this.refreshProducts();
    this.renderStockList();
    this.renderProductGrid();

    this.showToast(`商品「${prodName}」を削除しました`);

    // 5. GASへ削除通知（オンライン時）
    if (window.bitoSync.isOnline && window.bitoSync.gasUrl) {
      fetch(window.bitoSync.gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'deleteProduct', id: productId })
      }).catch((e) => console.log('Background product delete sync failed:', e));
    }
  }

  /**
   * 在庫クイック補充
   */
  async addStock(productId, amount) {
    this.vibrate(25);
    const p = this.products.find((prod) => prod.id === productId);
    if (!p) return;

    p.current_stock = (p.current_stock || 0) + amount;
    p.updated_at = new Date().toISOString();
    await window.bitoDB.upsertProduct(p);
    this.showToast(`「${p.name}」の在庫を +${amount} しました (現在 ${p.current_stock})`);
    this.renderStockList();
    this.renderProductGrid();

    // GASにも通知送信（オンライン時）
    if (window.bitoSync.isOnline && window.bitoSync.gasUrl) {
      fetch(window.bitoSync.gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'updateProduct', product: p })
      }).catch((e) => console.log('Background product sync failed:', e));
    }
  }

  /**
   * 新規商品の追加
   */
  async handleAddNewProduct() {
    const nameInput = document.getElementById('input-prod-name');
    const priceInput = document.getElementById('input-prod-price');
    const stockInput = document.getElementById('input-prod-stock');

    const name = nameInput.value.trim();
    const price = parseInt(priceInput.value, 10) || 0;
    const stock = parseInt(stockInput.value, 10) || 0;

    if (!name || price <= 0) {
      alert('商品名と正しい単価を入力してください。');
      return;
    }

    // 重複しないユニークな新ID生成
    const existingIds = new Set(this.products.map(p => p.id));
    let nextNum = this.products.length + 1;
    let newId = 'P' + String(nextNum).padStart(3, '0');
    while (existingIds.has(newId)) {
      nextNum++;
      newId = 'P' + String(nextNum).padStart(3, '0');
    }

    const newProduct = {
      id: newId,
      name: name,
      price: price,
      initial_stock: stock,
      current_stock: stock,
      updated_at: new Date().toISOString()
    };

    await window.bitoDB.upsertProduct(newProduct);
    await this.refreshProducts();
    this.renderStockList();
    this.renderProductGrid();

    nameInput.value = '';
    priceInput.value = '';
    stockInput.value = '';

    this.showToast(`新商品「${name}」を追加しました`);

    // GASにも追加通知
    if (window.bitoSync.isOnline && window.bitoSync.gasUrl) {
      fetch(window.bitoSync.gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'updateProduct', product: newProduct })
      }).catch((e) => console.log('Background product add sync failed:', e));
    }
  }

  /**
   * 通信状態インジケーターのUI更新
   */
  updateSyncIndicator(status) {
    const dot = document.getElementById('sync-dot');
    const label = document.getElementById('sync-label');

    if (!dot || !label) return;

    if (status.isSyncing) {
      dot.className = 'w-2.5 h-2.5 rounded-full bg-sky-400 animate-ping';
      label.textContent = '同期中...';
      label.className = 'text-xs font-semibold text-sky-400';
    } else if (status.isOnline) {
      dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400';
      label.textContent = 'オンライン';
      label.className = 'text-xs font-semibold text-emerald-400';
    } else {
      dot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400';
      label.textContent = 'オフライン(ローカル保存)';
      label.className = 'text-xs font-semibold text-amber-400';
    }
  }

  /**
   * 未同期件数バッジの更新
   */
  async updateUnsyncedBadge() {
    const unsynced = await window.bitoDB.getUnsyncedSales();
    const badge = document.getElementById('unsynced-badge');
    if (badge) {
      if (unsynced.length > 0) {
        badge.textContent = `未同期: ${unsynced.length}件`;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }
  }

  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }
  }

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  showToast(msg, duration = 2500) {
    let toast = document.getElementById('bito-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'bito-toast';
      toast.className = 'fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-slate-900/95 border border-sky-500/50 text-sky-200 text-sm font-semibold px-4 py-2.5 rounded-xl shadow-2xl transition-all duration-300 pointer-events-none opacity-0';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.remove('opacity-0', '-translate-y-2');
    toast.classList.add('opacity-100', 'translate-y-0');

    setTimeout(() => {
      toast.classList.remove('opacity-100', 'translate-y-0');
      toast.classList.add('opacity-0', '-translate-y-2');
    }, duration);
  }

  vibrate(pattern) {
    if ('vibrate' in navigator) {
      try {
        navigator.vibrate(pattern);
      } catch (e) {
        // 無視
      }
    }
  }

  escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

// 起動
document.addEventListener('DOMContentLoaded', () => {
  window.bitoApp = new BitoApp();
});
