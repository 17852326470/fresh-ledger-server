const http = require('http');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const PORT = 3100;

// ====== 数据存储 ======
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadData() {
  ensureDir();
  try {
    return JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8'));
  } catch {
    return { shops: [], records: [] };
  }
}

function saveData(data) {
  ensureDir();
  fs.writeFileSync(RECORDS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ====== 静态文件 serve ======
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(__dirname, 'public', urlPath);
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // 如果是 API 路径，返回 404
      if (urlPath.startsWith('/api/') || urlPath.startsWith('/admin/')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
        return;
      }
      // 否则返回 index.html（SPA 支持）
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ====== API 处理 ======
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
  });
}

function sendJSON(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

async function handleAPI(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const data = loadData();

  // GET /api/records — 获取记录列表
  if (path === '/api/records' && method === 'GET') {
    let filtered = [...data.records];
    const dateFilter = url.searchParams.get('date');
    const shopFilter = url.searchParams.get('shop');
    const statusFilter = url.searchParams.get('status');

    if (dateFilter && dateFilter !== 'all') filtered = filtered.filter(r => r.date === dateFilter);
    if (shopFilter) filtered = filtered.filter(r => r.shop === shopFilter);
    if (statusFilter) filtered = filtered.filter(r => r.status === statusFilter);

    return sendJSON(res, 200, { records: filtered, total: data.records.length });
  }

  // POST /api/records — 添加记录
  if (path === '/api/records' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const { shop, food, weight, price, money, status } = body;
      if (!shop || !food || !weight || !price) {
        return sendJSON(res, 400, { error: '缺少必填字段' });
      }

      const totalMoney = money || (parseFloat(weight) * parseFloat(price));
      const now = new Date();
      const date = now.toLocaleDateString('zh-CN');
      const time = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

      const record = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        date, time,
        shop, food,
        weight: parseFloat(weight),
        price: parseFloat(price),
        money: Math.round(totalMoney * 100) / 100,
        status: status || '未付',
        createdAt: now.toISOString()
      };

      data.records.unshift(record);
      saveData(data);
      return sendJSON(res, 200, { success: true, record });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // PUT /api/records/:id/toggle-status — 切换付款状态
  if (path.match(/^\/api\/records\/([^/]+)\/toggle-status$/) && method === 'PUT') {
    const id = path.match(/^\/api\/records\/([^/]+)\/toggle-status$/)[1];
    const record = data.records.find(r => r.id === id);
    if (!record) return sendJSON(res, 404, { error: '记录不存在' });

    record.status = record.status === '未付' ? '已付' : '未付';
    saveData(data);
    return sendJSON(res, 200, { success: true, record });
  }

  // DELETE /api/records/:id — 删除记录
  if (path.match(/^\/api\/records\/([^/]+)$/) && method === 'DELETE') {
    const id = path.match(/^\/api\/records\/([^/]+)$/)[1];
    const idx = data.records.findIndex(r => r.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: '记录不存在' });
    
    data.records.splice(idx, 1);
    saveData(data);
    return sendJSON(res, 200, { success: true });
  }

  // PUT /api/records/pay-all — 全部已付
  if (path === '/api/records/pay-all' && method === 'PUT') {
    data.records.forEach(r => { if (r.status === '未付') r.status = '已付'; });
    saveData(data);
    return sendJSON(res, 200, { success: true, count: data.records.length });
  }

  // GET /api/shops — 获取商家列表
  if (path === '/api/shops' && method === 'GET') {
    return sendJSON(res, 200, { shops: data.shops });
  }

  // POST /api/shops — 添加商家
  if (path === '/api/shops' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const name = body.name?.trim();
      if (!name) return sendJSON(res, 400, { error: '请输入商家名称' });
      if (data.shops.includes(name)) return sendJSON(res, 400, { error: '商家已存在' });

      data.shops.push(name);
      saveData(data);
      return sendJSON(res, 200, { success: true, name });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // DELETE /api/shops/:name — 删除商家
  if (path.startsWith('/api/shops/') && method === 'DELETE') {
    const name = decodeURIComponent(path.replace('/api/shops/', ''));
    const idx = data.shops.indexOf(name);
    if (idx === -1) return sendJSON(res, 404, { error: '商家不存在' });
    
    data.shops.splice(idx, 1);
    saveData(data);
    return sendJSON(res, 200, { success: true });
  }

  // GET /api/summary — 获取今日概览 & 欠款汇总
  if (path === '/api/summary' && method === 'GET') {
    const today = new Date().toLocaleDateString('zh-CN');
    const todayRecords = data.records.filter(r => r.date === today);
    const unpayRecords = data.records.filter(r => r.status === '未付');

    const debtByShop = {};
    unpayRecords.forEach(r => {
      debtByShop[r.shop] = (debtByShop[r.shop] || 0) + r.money;
    });

    return sendJSON(res, 200, {
      today: {
        count: todayRecords.length,
        total: todayRecords.reduce((s, r) => s + r.money, 0)
      },
      debt: {
        total: unpayRecords.reduce((s, r) => s + r.money, 0),
        byShop: debtByShop
      },
      totalRecords: data.records.length
    });
  }

  // GET /api/dates — 获取所有日期
  if (path === '/api/dates' && method === 'GET') {
    const dates = [...new Set(data.records.map(r => r.date))].sort((a, b) => new Date(b) - new Date(a));
    return sendJSON(res, 200, { dates });
  }

  // GET /api/export — 导出 CSV
  if (path === '/api/export' && method === 'GET') {
    let csv = '\uFEFF日期,时间,商家,菜品,斤数,进价(元/斤),总金额(元),状态\n';
    data.records.forEach(r => {
      csv += `${r.date},${r.time||''},${r.shop},${r.food},${r.weight},${r.price},${r.money},${r.status}\n`;
    });
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="生鲜台账_${new Date().toISOString().slice(0, 10)}.csv"`
    });
    res.end(csv);
    return;
  }

  // DELETE /api/records — 清空所有记录
  if (path === '/api/records' && method === 'DELETE') {
    data.records = [];
    saveData(data);
    return sendJSON(res, 200, { success: true });
  }

  // 管理后台 API
  // GET /api/admin/stats — 管理统计
  if (path === '/api/admin/stats' && method === 'GET') {
    const unpayCount = data.records.filter(r => r.status === '未付').length;
    const topShops = {};
    data.records.forEach(r => {
      topShops[r.shop] = (topShops[r.shop] || 0) + r.money;
    });
    const topShopList = Object.entries(topShops)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([shop, total]) => ({ shop, total: Math.round(total * 100) / 100 }));

    return sendJSON(res, 200, {
      totalRecords: data.records.length,
      totalShops: data.shops.length,
      unpayCount,
      totalSpent: Math.round(data.records.reduce((s, r) => s + r.money, 0) * 100) / 100,
      topShops: topShopList
    });
  }

  // 管理后台页面
  if (path === '/admin' || path.startsWith('/admin/')) {
    const adminFile = path === '/admin' ? '/admin.html' : path;
    fs.readFile(path.join(__dirname, 'public', adminFile), (err, d) => {
      if (err) {
        return sendJSON(res, 404, { error: 'Admin page not found' });
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(d);
    });
    return;
  }

  // 未匹配 API
  sendJSON(res, 404, { error: 'API not found' });
}

// ====== 启动 ======
const server = http.createServer((req, res) => {
  const url = req.url;
  if (url.startsWith('/api/') || url.startsWith('/admin')) {
    handleAPI(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`\n🥬 生鲜台账服务已启动！`);
  console.log(`   前台记账: http://127.0.0.1:${PORT}/`);
  console.log(`   管理后台: http://127.0.0.1:${PORT}/admin`);
  console.log(`   数据文件: ${RECORDS_FILE}\n`);
});
