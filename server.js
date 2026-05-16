const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'ledger.db');
const PORT = process.env.PORT || 3100;

// ====== SQLite 数据库 ======
function initDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  
  const db = new Database(DB_PATH);
  
  // 启用 WAL 模式，性能更好
  db.pragma('journal_mode = WAL');
  
  // 创建表
  db.exec(`
    CREATE TABLE IF NOT EXISTS shops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      createdAt TEXT DEFAULT (datetime('now'))
    );
    
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      time TEXT,
      shop TEXT NOT NULL,
      food TEXT NOT NULL,
      weight REAL NOT NULL,
      price REAL NOT NULL,
      money REAL NOT NULL,
      status TEXT DEFAULT '未付',
      createdAt TEXT DEFAULT (datetime('now'))
    );
    
    CREATE INDEX IF NOT EXISTS idx_records_date ON records(date);
    CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
    CREATE INDEX IF NOT EXISTS idx_records_shop ON records(shop);
  `);
  
  return db;
}

const db = initDB();

// ====== 数据访问函数 ======
function getShops() {
  const rows = db.prepare('SELECT name FROM shops ORDER BY name').all();
  return rows.map(r => r.name);
}

function addShop(name) {
  db.prepare('INSERT INTO shops (name) VALUES (?)').run(name);
}

function deleteShop(name) {
  db.prepare('DELETE FROM shops WHERE name = ?').run(name);
}

function getRecords(filters = {}) {
  let sql = 'SELECT * FROM records WHERE 1=1';
  const params = [];
  
  if (filters.date && filters.date !== 'all') {
    sql += ' AND date = ?';
    params.push(filters.date);
  }
  if (filters.shop) {
    sql += ' AND shop = ?';
    params.push(filters.shop);
  }
  if (filters.status) {
    sql += ' AND status = ?';
    params.push(filters.status);
  }
  
  sql += ' ORDER BY createdAt DESC';
  
  return db.prepare(sql).all(...params);
}

function addRecord(record) {
  db.prepare(`
    INSERT INTO records (id, date, time, shop, food, weight, price, money, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(record.id, record.date, record.time, record.shop, record.food,
         record.weight, record.price, record.money, record.status);
}

function toggleRecordStatus(id) {
  const record = db.prepare('SELECT * FROM records WHERE id = ?').get(id);
  if (!record) return null;
  
  const newStatus = record.status === '未付' ? '已付' : '未付';
  db.prepare('UPDATE records SET status = ? WHERE id = ?').run(newStatus, id);
  return { ...record, status: newStatus };
}

function deleteRecord(id) {
  db.prepare('DELETE FROM records WHERE id = ?').run(id);
}

function payAllDebt() {
  const result = db.prepare('UPDATE records SET status = ? WHERE status = ?').run('已付', '未付');
  return result.changes;
}

function getSummary() {
  const today = new Date().toLocaleDateString('zh-CN');
  
  const todayStats = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(money), 0) as total
    FROM records WHERE date = ?
  `).get(today);
  
  const debtStats = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(money), 0) as total
    FROM records WHERE status = '未付'
  `).get();
  
  const debtByShop = db.prepare(`
    SELECT shop, COALESCE(SUM(money), 0) as total
    FROM records WHERE status = '未付'
    GROUP BY shop ORDER BY total DESC
  `).all();
  
  const totalRecords = db.prepare('SELECT COUNT(*) as count FROM records').get();
  
  const debtObj = {};
  debtByShop.forEach(r => { debtObj[r.shop] = r.total; });
  
  return {
    today: { count: todayStats.count, total: todayStats.total },
    debt: { total: debtStats.total, byShop: debtObj },
    totalRecords: totalRecords.count
  };
}

function getDates() {
  return db.prepare('SELECT DISTINCT date FROM records ORDER BY date DESC').all().map(r => r.date);
}

function getAdminStats() {
  const totalRecords = db.prepare('SELECT COUNT(*) as count FROM records').get().count;
  const totalShops = db.prepare('SELECT COUNT(*) as count FROM shops').get().count;
  const unpayCount = db.prepare("SELECT COUNT(*) as count FROM records WHERE status = '未付'").get().count;
  const totalSpent = db.prepare('SELECT COALESCE(SUM(money), 0) as total FROM records').get().total;
  
  const topShops = db.prepare(`
    SELECT shop, ROUND(COALESCE(SUM(money), 0), 2) as total
    FROM records GROUP BY shop ORDER BY total DESC LIMIT 10
  `).all();
  
  return { totalRecords, totalShops, unpayCount, totalSpent, topShops };
}

function clearAllRecords() {
  db.prepare('DELETE FROM records').run();
}

function getAllRecordsForExport() {
  return db.prepare('SELECT * FROM records ORDER BY createdAt DESC').all();
}

function getLocalDateStr(date) {
  if (!date) date = new Date();
  // 使用 toLocaleDateString('zh-CN') 得到如 "2026/5/16" 格式
  // 但我们想要 "2026年5月16日" 这种显示格式统一
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
  // 用 / 分隔在 SQLite 排序和过滤中更可靠
}

function getLocalTimeStr(date) {
  if (!date) date = new Date();
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// ====== 静态文件 ======
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// ====== HTTP Server ======
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
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(__dirname, 'public', urlPath);
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (urlPath.startsWith('/api/') || urlPath.startsWith('/admin/')) {
        return sendJSON(res, 404, { error: 'Not Found' });
      }
      return fs.readFile(path.join(__dirname, 'public', 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d2);
      });
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleAPI(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  
  try {
    // GET /api/shops
    if (pathname === '/api/shops' && method === 'GET') {
      return sendJSON(res, 200, { shops: getShops() });
    }
    
    // POST /api/shops
    if (pathname === '/api/shops' && method === 'POST') {
      const body = await parseBody(req);
      const name = body.name?.trim();
      if (!name) return sendJSON(res, 400, { error: '请输入商家名称' });
      try {
        addShop(name);
        return sendJSON(res, 200, { success: true, name });
      } catch {
        return sendJSON(res, 400, { error: '商家已存在' });
      }
    }
    
    // DELETE /api/shops/:name
    if (pathname.startsWith('/api/shops/') && method === 'DELETE') {
      const name = decodeURIComponent(pathname.replace('/api/shops/', ''));
      deleteShop(name);
      return sendJSON(res, 200, { success: true });
    }
    
    // GET /api/records
    if (pathname === '/api/records' && method === 'GET') {
      const filters = {
        date: url.searchParams.get('date'),
        shop: url.searchParams.get('shop'),
        status: url.searchParams.get('status')
      };
      return sendJSON(res, 200, { records: getRecords(filters), total: getAdminStats().totalRecords });
    }
    
    // POST /api/records
    if (pathname === '/api/records' && method === 'POST') {
      const body = await parseBody(req);
      const { shop, food, weight, price, money, status } = body;
      if (!shop || !food || !weight || !price) {
        return sendJSON(res, 400, { error: '缺少必填字段' });
      }
      
      const now = new Date();
      const record = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        date: getLocalDateStr(now),
        time: getLocalTimeStr(now),
        shop, food,
        weight: parseFloat(weight),
        price: parseFloat(price),
        money: money ? Math.round(parseFloat(money) * 100) / 100 : Math.round(parseFloat(weight) * parseFloat(price) * 100) / 100,
        status: status || '未付'
      };
      
      addRecord(record);
      return sendJSON(res, 200, { success: true, record });
    }
    
    // DELETE /api/records (clear all)
    if (pathname === '/api/records' && method === 'DELETE') {
      clearAllRecords();
      return sendJSON(res, 200, { success: true });
    }
    
    // PUT /api/records/pay-all
    if (pathname === '/api/records/pay-all' && method === 'PUT') {
      const count = payAllDebt();
      return sendJSON(res, 200, { success: true, count });
    }
    
    // PUT /api/records/:id/toggle-status
    const toggleMatch = pathname.match(/^\/api\/records\/([^/]+)\/toggle-status$/);
    if (toggleMatch && method === 'PUT') {
      const result = toggleRecordStatus(toggleMatch[1]);
      if (!result) return sendJSON(res, 404, { error: '记录不存在' });
      return sendJSON(res, 200, { success: true, record: result });
    }
    
    // DELETE /api/records/:id
    const deleteMatch = pathname.match(/^\/api\/records\/([^/]+)$/);
    if (deleteMatch && method === 'DELETE') {
      deleteRecord(deleteMatch[1]);
      return sendJSON(res, 200, { success: true });
    }
    
    // GET /api/summary
    if (pathname === '/api/summary' && method === 'GET') {
      return sendJSON(res, 200, getSummary());
    }
    
    // GET /api/dates
    if (pathname === '/api/dates' && method === 'GET') {
      return sendJSON(res, 200, { dates: getDates() });
    }
    
    // GET /api/export
    if (pathname === '/api/export' && method === 'GET') {
      const all = getAllRecordsForExport();
      let csv = '\uFEFF日期,时间,商家,菜品,斤数,进价(元/斤),总金额(元),状态\n';
      all.forEach(r => {
        csv += `${r.date},${r.time||''},${r.shop},${r.food},${r.weight},${r.price},${r.money},${r.status}\n`;
      });
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="生鲜台账_${new Date().toISOString().slice(0, 10)}.csv"`
      });
      return res.end(csv);
    }
    
    // GET /api/admin/stats
    if (pathname === '/api/admin/stats' && method === 'GET') {
      return sendJSON(res, 200, getAdminStats());
    }
    
    // GET /api/localtime — 返回服务器时间（供前端同步）
    if (pathname === '/api/localtime' && method === 'GET') {
      return sendJSON(res, 200, {
        serverTime: new Date().toISOString(),
        localDate: getLocalDateStr(new Date()),
        localTime: getLocalTimeStr(new Date())
      });
    }
    
    // 管理后台页面
    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      const adminFile = pathname === '/admin' ? '/admin.html' : pathname;
      return fs.readFile(path.join(__dirname, 'public', adminFile), (err, d) => {
        if (err) return sendJSON(res, 404, { error: 'Admin page not found' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d);
      });
    }
    
    sendJSON(res, 404, { error: 'API not found' });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
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
  console.log(`   前台记账: http://localhost:${PORT}/`);
  console.log(`   管理后台: http://localhost:${PORT}/admin`);
  console.log(`   数据库: ${DB_PATH}\n`);
});
