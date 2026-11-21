/**
 * 美東 資金造成会計アプリ (Bito POS) - 管理・分析ダッシュボード & CSVエクスポート
 */

class BitoAdmin {
  constructor() {
    this.sales = [];
    this.products = [];
  }

  async loadData() {
    this.sales = await window.bitoDB.getAllSales();
    this.products = await window.bitoDB.getProducts();
    return { sales: this.sales, products: this.products };
  }

  /**
   * ダッシュボード集計値の計算
   */
  computeMetrics() {
    const totalRevenue = this.sales.reduce((sum, s) => sum + (s.total_amount || 0), 0);
    const totalTransactions = this.sales.length;
    let totalItemsSold = 0;

    // 商品別集計マップ
    const productStats = {};
    this.products.forEach(p => {
      productStats[p.id] = {
        id: p.id,
        name: p.name,
        price: p.price,
        initial_stock: p.initial_stock || 0,
        current_stock: p.current_stock || 0,
        quantitySold: 0,
        revenue: 0
      };
    });

    // 担当者別集計マップ
    const deviceStats = {};

    // 時間帯別集計マップ (0〜23時)
    const hourlyStats = {};
    for (let h = 8; h <= 21; h++) {
      const label = `${String(h).padStart(2, '0')}:00`;
      hourlyStats[label] = { label, count: 0, quantity: 0, revenue: 0 };
    }

    this.sales.forEach(sale => {
      // 担当者別
      const dev = sale.device_id || '未設定';
      if (!deviceStats[dev]) {
        deviceStats[dev] = { device_id: dev, count: 0, revenue: 0, items: 0 };
      }
      deviceStats[dev].count += 1;
      deviceStats[dev].revenue += (sale.total_amount || 0);

      // 時間帯別
      const date = new Date(sale.timestamp);
      const hour = date.getHours();
      const hourLabel = `${String(hour).padStart(2, '0')}:00`;
      if (!hourlyStats[hourLabel]) {
        hourlyStats[hourLabel] = { label: hourLabel, count: 0, quantity: 0, revenue: 0 };
      }
      hourlyStats[hourLabel].count += 1;
      hourlyStats[hourLabel].revenue += (sale.total_amount || 0);

      // 商品別
      if (sale.items && Array.isArray(sale.items)) {
        sale.items.forEach(item => {
          totalItemsSold += (item.quantity || 0);
          if (deviceStats[dev]) {
            deviceStats[dev].items += (item.quantity || 0);
          }
          if (hourlyStats[hourLabel]) {
            hourlyStats[hourLabel].quantity += (item.quantity || 0);
          }

          if (!productStats[item.product_id]) {
            productStats[item.product_id] = {
              id: item.product_id,
              name: item.name || '不明な商品',
              price: item.price || 0,
              initial_stock: 0,
              current_stock: 0,
              quantitySold: 0,
              revenue: 0
            };
          }
          productStats[item.product_id].quantitySold += item.quantity;
          productStats[item.product_id].revenue += item.subtotal;
        });
      }
    });

    const averageBasket = totalTransactions > 0 ? Math.round(totalRevenue / totalTransactions) : 0;

    return {
      totalRevenue,
      totalTransactions,
      totalItemsSold,
      averageBasket,
      productStats: Object.values(productStats),
      deviceStats: Object.values(deviceStats),
      hourlyStats: Object.values(hourlyStats)
    };
  }

  /**
   * ダッシュボード画面のUI更新
   */
  async renderDashboard() {
    await this.loadData();
    const metrics = this.computeMetrics();

    // 1. KPIサマリーカードの反映
    const elRevenue = document.getElementById('dash-total-revenue');
    const elCount = document.getElementById('dash-total-transactions');
    const elItems = document.getElementById('dash-total-items');
    const elAvg = document.getElementById('dash-average-basket');

    if (elRevenue) elRevenue.textContent = `¥${metrics.totalRevenue.toLocaleString()}`;
    if (elCount) elCount.textContent = `${metrics.totalTransactions.toLocaleString()} 件`;
    if (elItems) elItems.textContent = `${metrics.totalItemsSold.toLocaleString()} 個`;
    if (elAvg) elAvg.textContent = `¥${metrics.averageBasket.toLocaleString()}`;

    // 2. 時間帯別グラフの描画
    this.renderHourlyChart(metrics.hourlyStats);

    // 3. 商品別売上グラフの描画
    this.renderProductChart(metrics.productStats);

    // 4. 担当者別実績テーブル
    this.renderDeviceTable(metrics.deviceStats);

    // 5. 商品別詳細テーブル
    this.renderProductTable(metrics.productStats);
  }

  /**
   * 時間帯別売上バーチャート (Canvasネイティブ描画: 完全オフライン対応)
   */
  renderHourlyChart(hourlyData) {
    const canvas = document.getElementById('chart-hourly');
    if (!canvas) return;

    // 非表示時間帯のフィルタリング（売上がある、またはコア時間帯10:00〜18:00）
    const displayData = hourlyData.filter(h => {
      const hourNum = parseInt(h.label);
      return (hourNum >= 9 && hourNum <= 20) || h.revenue > 0;
    });

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    ctx.clearRect(0, 0, width, height);

    if (displayData.length === 0) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('売上データがまだありません', width / 2, height / 2);
      return;
    }

    const padding = { top: 25, right: 15, bottom: 35, left: 55 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    const maxRev = Math.max(...displayData.map(d => d.revenue), 1000);
    // Y軸目盛り (3本)
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';

    for (let i = 0; i <= 3; i++) {
      const val = Math.round((maxRev / 3) * i);
      const y = padding.top + chartH - (chartH * (i / 3));
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
      ctx.fillText(`¥${val.toLocaleString()}`, padding.left - 8, y + 4);
    }

    // 棒グラフ
    const barWidth = Math.max(12, Math.min(32, (chartW / displayData.length) * 0.65));
    const step = chartW / displayData.length;

    displayData.forEach((d, idx) => {
      const x = padding.left + (idx * step) + (step - barWidth) / 2;
      const barH = (d.revenue / maxRev) * chartH;
      const y = padding.top + chartH - barH;

      // グラデーション棒
      const grad = ctx.createLinearGradient(0, y, 0, padding.top + chartH);
      grad.addColorStop(0, '#3b82f6');
      grad.addColorStop(1, '#1d4ed8');

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, Math.max(2, barH), [4, 4, 0, 0]);
      ctx.fill();

      // 金額ラベル（売上がある場合）
      if (d.revenue > 0) {
        ctx.fillStyle = '#38bdf8';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`¥${d.revenue}`, x + barWidth / 2, Math.max(padding.top - 5, y - 4));
      }

      // X軸時刻ラベル
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(d.label, x + barWidth / 2, height - 12);
    });
  }

  /**
   * 商品別売上シェア (水平バーチャート)
   */
  renderProductChart(productStats) {
    const canvas = document.getElementById('chart-product');
    if (!canvas) return;

    // 売上順ソート
    const sorted = [...productStats].sort((a, b) => b.revenue - a.revenue).slice(0, 8);

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    ctx.clearRect(0, 0, width, height);

    const maxRev = Math.max(...sorted.map(s => s.revenue), 100);
    const rowH = (height - 30) / Math.max(1, sorted.length);

    sorted.forEach((item, idx) => {
      const y = 20 + idx * rowH;
      const barRatio = maxRev > 0 ? (item.revenue / maxRev) : 0;
      const barW = Math.max(4, (width - 170) * barRatio);

      // 商品名
      ctx.fillStyle = '#f1f5f9';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'left';
      const truncatedName = item.name.length > 8 ? item.name.substring(0, 7) + '…' : item.name;
      ctx.fillText(truncatedName, 10, y + 14);

      // 棒
      const grad = ctx.createLinearGradient(100, 0, 100 + barW, 0);
      grad.addColorStop(0, '#10b981');
      grad.addColorStop(1, '#059669');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(100, y, barW, Math.max(14, rowH - 12), 4);
      ctx.fill();

      // 数値 (¥金額 / 個数)
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`¥${item.revenue.toLocaleString()} (${item.quantitySold}個)`, 110 + barW, y + 14);
    });
  }

  renderDeviceTable(deviceStats) {
    const tbody = document.getElementById('dash-device-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (deviceStats.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-slate-400">データなし</td></tr>`;
      return;
    }

    deviceStats.forEach(d => {
      const tr = document.createElement('tr');
      tr.className = 'border-b border-slate-700/50 hover:bg-slate-800/40 text-sm';
      tr.innerHTML = `
        <td class="py-2 px-3 font-semibold text-slate-200">
          <span class="inline-block w-2.5 h-2.5 rounded-full ${d.device_id.includes('歩き') ? 'bg-amber-400' : 'bg-blue-400'} mr-2"></span>
          ${this.escapeHtml(d.device_id)}
        </td>
        <td class="py-2 px-3 text-right text-slate-300">${d.count} 回</td>
        <td class="py-2 px-3 text-right text-slate-300">${d.items} 個</td>
        <td class="py-2 px-3 text-right font-bold text-emerald-400">¥${d.revenue.toLocaleString()}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  renderProductTable(productStats) {
    const tbody = document.getElementById('dash-product-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    productStats.forEach(p => {
      const tr = document.createElement('tr');
      tr.className = 'border-b border-slate-700/50 hover:bg-slate-800/40 text-sm';

      const stockBadge = p.current_stock <= 0
        ? `<span class="px-2 py-0.5 text-xs font-bold bg-rose-500/20 text-rose-300 rounded border border-rose-500/40">完売</span>`
        : p.current_stock <= 10
          ? `<span class="px-2 py-0.5 text-xs font-bold bg-amber-500/20 text-amber-300 rounded border border-amber-500/40">残 ${p.current_stock}</span>`
          : `<span class="px-2 py-0.5 text-xs font-semibold bg-emerald-500/20 text-emerald-300 rounded">残 ${p.current_stock}</span>`;

      tr.innerHTML = `
        <td class="py-2.5 px-3 font-medium text-slate-200">${this.escapeHtml(p.name)}</td>
        <td class="py-2.5 px-3 text-right text-slate-300">¥${p.price.toLocaleString()}</td>
        <td class="py-2.5 px-3 text-right font-bold text-sky-400">${p.quantitySold} 個</td>
        <td class="py-2.5 px-3 text-right">${stockBadge}</td>
        <td class="py-2.5 px-3 text-right font-bold text-emerald-400">¥${p.revenue.toLocaleString()}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  // --- CSVエクスポート機能 (BOM付きUTF-8) ---

  /**
   * 売上全明細 CSV のダウンロード
   */
  async exportSalesDetailCsv() {
    await this.loadData();
    const rows = [];
    rows.push(['伝票番号', '日時', '担当端末', '商品ID', '商品名', '単価', '数量', '小計', '合計金額', '同期状態']);

    this.sales.forEach(sale => {
      const timeStr = new Date(sale.timestamp).toLocaleString('ja-JP');
      const syncedStr = sale.synced ? '同期済' : '未同期(端末保存)';

      if (sale.items && sale.items.length > 0) {
        sale.items.forEach(item => {
          rows.push([
            sale.transaction_id,
            timeStr,
            sale.device_id || '未設定',
            item.product_id,
            item.name,
            item.price,
            item.quantity,
            item.subtotal,
            sale.total_amount,
            syncedStr
          ]);
        });
      } else {
        rows.push([
          sale.transaction_id,
          timeStr,
          sale.device_id || '未設定',
          '',
          '',
          '',
          0,
          0,
          sale.total_amount,
          syncedStr
        ]);
      }
    });

    this.downloadCsv(rows, `美東_売上明細_${this.getTimestampString()}.csv`);
  }

  /**
   * 商品別売上集計 CSV のダウンロード
   */
  async exportProductSummaryCsv() {
    await this.loadData();
    const metrics = this.computeMetrics();
    const rows = [];
    rows.push(['商品ID', '商品名', '単価', '初期在庫', '販売数量', '残在庫', '売上合計金額', '販売率(%)']);

    metrics.productStats.forEach(p => {
      const init = p.initial_stock || (p.current_stock + p.quantitySold);
      const sellRate = init > 0 ? ((p.quantitySold / init) * 100).toFixed(1) : '0.0';
      rows.push([
        p.id,
        p.name,
        p.price,
        p.initial_stock,
        p.quantitySold,
        p.current_stock,
        p.revenue,
        `${sellRate}%`
      ]);
    });

    this.downloadCsv(rows, `美東_商品別売上集計_${this.getTimestampString()}.csv`);
  }

  /**
   * 時間帯別集計 CSV のダウンロード
   */
  async exportHourlySummaryCsv() {
    await this.loadData();
    const metrics = this.computeMetrics();
    const rows = [];
    rows.push(['時間帯', '注文件数', '販売総個数', '売上合計金額']);

    metrics.hourlyStats.forEach(h => {
      rows.push([
        h.label,
        h.count,
        h.quantity,
        h.revenue
      ]);
    });

    this.downloadCsv(rows, `美東_時間帯別売上集計_${this.getTimestampString()}.csv`);
  }

  /**
   * CSV文字列生成とブラウザダウンロード（UTF-8 BOM付き）
   */
  downloadCsv(rows, filename) {
    const csvContent = rows.map(row => {
      return row.map(val => {
        let str = String(val === undefined || val === null ? '' : val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          str = `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }).join(',');
    }).join('\r\n');

    // UTF-8 BOM (\uFEFF) を付与することでExcelで文字化けを防止
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  getTimestampString() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    return `${y}${m}${d}_${h}${min}`;
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

window.bitoAdmin = new BitoAdmin();
