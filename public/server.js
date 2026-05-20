const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'ledger.db');
const PORT = process.env.PORT || 3100;

// ====== 管理后台 Basic Auth ======
const ADMIN_USER = '123456';
const ADMIN_PASS = '123456';

// ====== SQLite 数据库(使用 sql.js,纯 JS 无需编译) ======
let db;

async function initDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const SQL = await initSqlJs();

  // 尝试加载已有数据库
  let buffer;
  try {
    buffer = fs.readFileSync(DB_PATH);
  } catch {
    buffer = null;
  }

  db = new SQL.Database(buffer);

  // 创建表
  db.run(`
    CREATE TABLE IF NOT EXISTS shops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      certificates TEXT DEFAULT '[]',
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
      type TEXT DEFAULT '自采',
      createdAt TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      food TEXT NOT NULL,
      weight REAL NOT NULL,
      targetDate TEXT NOT NULL,
      time TEXT,
      unit TEXT DEFAULT '斤',
      remark TEXT DEFAULT '',
      createdAt TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      time TEXT,
      shop TEXT NOT NULL,
      action TEXT NOT NULL,
      bigBox INTEGER DEFAULT 0,
      smallBox INTEGER DEFAULT 0,
      amount REAL DEFAULT 0,
      photo TEXT DEFAULT '',
      buyer TEXT DEFAULT 'A',
      createdAt TEXT DEFAULT (datetime('now'))
    );

  `);

  // 兼容旧表:shops 加字段
  try { db.exec("SELECT phone FROM shops LIMIT 1"); } catch(e) { db.run("ALTER TABLE shops ADD COLUMN phone TEXT DEFAULT ''"); }
  try { db.exec("SELECT address FROM shops LIMIT 1"); } catch(e) { db.run("ALTER TABLE shops ADD COLUMN address TEXT DEFAULT ''"); }
  try { db.exec("SELECT certificates FROM shops LIMIT 1"); } catch(e) { db.run("ALTER TABLE shops ADD COLUMN certificates TEXT DEFAULT '[]'"); }

  // 检查是否有单位字段(兼容旧表)
  try {
    db.exec("SELECT unit FROM orders LIMIT 1");
  } catch(e) {
    db.run("ALTER TABLE orders ADD COLUMN unit TEXT DEFAULT '斤'");
  }
  try {
    db.exec("SELECT remark FROM orders LIMIT 1");
  } catch(e) {
    db.run("ALTER TABLE orders ADD COLUMN remark TEXT DEFAULT ''");
  }

  // 创建 sales 和 stock 表
  db.run(`
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      shop TEXT,
      food TEXT NOT NULL,
      weight REAL DEFAULT 0,
      unit TEXT DEFAULT 'kg',
      price REAL DEFAULT 0,
      cost REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      profit REAL DEFAULT 0,
      createdAt TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      shop TEXT DEFAULT '呱呱精品生鲜连锁店3店',
      food TEXT NOT NULL,
      initStock REAL DEFAULT 0,
      unit TEXT DEFAULT '斤',
      updatedAt TEXT DEFAULT (datetime('now'))
    );
  `);

  // 保存到文件
  saveDB();
}

function saveDB() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// ====== 数据访问 ======
function getShops() {
  const results = db.exec('SELECT name FROM shops ORDER BY name');
  if (results.length === 0) return [];
  return results[0].values.map(r => r[0]);
}

function getShop(name) {
  const stmt = db.prepare('SELECT * FROM shops WHERE name = ?');
  stmt.bind([name]);
  let shop = null;
  if (stmt.step()) {
    shop = stmt.getAsObject();
    try { shop.certificates = JSON.parse(shop.certificates || '[]'); } catch { shop.certificates = []; }
  }
  stmt.free();
  return shop;
}

function updateShop(name, data) {
  const fields = [];
  const values = [];
  if (data.phone !== undefined) { fields.push('phone = ?'); values.push(data.phone); }
  if (data.address !== undefined) { fields.push('address = ?'); values.push(data.address); }
  if (data.certificates !== undefined) { fields.push('certificates = ?'); values.push(JSON.stringify(data.certificates)); }
  if (fields.length === 0) return false;
  values.push(name);
  db.run('UPDATE shops SET ' + fields.join(', ') + ' WHERE name = ?', values);
  saveDB();
  return true;
}

function addShop(name) {
  db.run('INSERT INTO shops (name) VALUES (?)', [name]);
  saveDB();
}

function deleteShop(name) {
  db.run('DELETE FROM shops WHERE name = ?', [name]);
  saveDB();
}

function addShopCertificate(shopName, filePath) {
  const shop = getShop(shopName);
  if (!shop) return false;
  const certs = shop.certificates || [];
  certs.push({ path: filePath, uploadedAt: new Date().toISOString() });
  updateShop(shopName, { certificates: certs });
  return true;
}

function removeShopCertificate(shopName, certPath) {
  const shop = getShop(shopName);
  if (!shop) return false;
  const certs = (shop.certificates || []).filter(c => c.path !== certPath);
  updateShop(shopName, { certificates: certs });
  // 也删除物理文件
  const fullPath = path.join(__dirname, 'public', certPath);
  try { fs.unlinkSync(fullPath); } catch {}
  return true;
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
  if (filters.type) {
    sql += ' AND type = ?';
    params.push(filters.type);
  }

  sql += ' ORDER BY createdAt DESC';

  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function addRecord(record) {
  db.run(`
    INSERT INTO records (id, date, time, shop, food, weight, unit, price, money, status, type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [record.id, record.date, record.time, record.shop, record.food,
       record.weight, record.unit || '斤', record.price, record.money, record.status, record.type || '自采']);
  saveDB();
}

function toggleRecordStatus(id) {
  const stmt = db.prepare('SELECT * FROM records WHERE id = ?');
  stmt.bind([id]);
  let record = null;
  if (stmt.step()) record = stmt.getAsObject();
  stmt.free();

  if (!record) return null;

  const newStatus = record.status === '未付' ? '已付' : '未付';
  db.run('UPDATE records SET status = ? WHERE id = ?', [newStatus, id]);
  saveDB();
  return { ...record, status: newStatus };
}

function deleteRecord(id) {
  db.run('DELETE FROM records WHERE id = ?', [id]);
  saveDB();
}

function payAllDebt() {
  const stmt = db.prepare("SELECT COUNT(*) as count FROM records WHERE status = '未付'");
  stmt.step();
  const count = stmt.getAsObject().count;
  stmt.free();

  db.run("UPDATE records SET status = '已付' WHERE status = '未付'");
  saveDB();
  return count;
}

function matchKitchenPrices() {
  // 找所有进价为0的后厨记录,按菜品分组
  let stmt = db.prepare("SELECT DISTINCT food FROM records WHERE type = '后厨' AND price = 0");
  const foods = [];
  while (stmt.step()) foods.push(stmt.getAsObject().food);
  stmt.free();

  let matched = 0;
  foods.forEach(food => {
    // 查找该菜品最新的自采记录
    stmt = db.prepare("SELECT price, weight FROM records WHERE type = '自采' AND food = ? ORDER BY createdAt DESC LIMIT 1");
    stmt.bind([food]);
    if (stmt.step()) {
      const latest = stmt.getAsObject();
      const price = latest.price;

      // 更新所有该菜品进价为0的后厨记录
      db.run("UPDATE records SET price = ?, money = ROUND(weight * ?, 2) WHERE type = '后厨' AND food = ? AND price = 0",
        [price, price, food]);
      matched += db.getRowsModified();
    }
    stmt.free();
  });

  saveDB();
  return matched;
}

function getSummary() {
  const today = new Date().toLocaleDateString('zh-CN');

  let stmt = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(money), 0) as total FROM records WHERE date = ?");
  stmt.bind([today]);
  stmt.step();
  const todayStats = stmt.getAsObject();
  stmt.free();

  stmt = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(money), 0) as total FROM records WHERE status = '未付'");
  stmt.step();
  const debtStats = stmt.getAsObject();
  stmt.free();

  stmt = db.prepare("SELECT shop, COALESCE(SUM(money), 0) as total FROM records WHERE status = '未付' GROUP BY shop ORDER BY total DESC");
  const debtByShop = [];
  while (stmt.step()) debtByShop.push(stmt.getAsObject());
  stmt.free();

  stmt = db.prepare('SELECT COUNT(*) as count FROM records');
  stmt.step();
  const totalCount = stmt.getAsObject().count;
  stmt.free();

  const debtObj = {};
  debtByShop.forEach(r => { debtObj[r.shop] = r.total; });

  return {
    today: { count: todayStats.count, total: todayStats.total },
    debt: { total: debtStats.total, byShop: debtObj },
    totalRecords: totalCount
  };
}

function getDates() {
  const results = db.exec('SELECT DISTINCT date FROM records ORDER BY date DESC');
  if (results.length === 0) return [];
  return results[0].values.map(r => r[0]);
}

function getAdminStats() {
  let stmt = db.prepare('SELECT COUNT(*) as count FROM records');
  stmt.step();
  const totalRecords = stmt.getAsObject().count;
  stmt.free();

  stmt = db.prepare('SELECT COUNT(*) as count FROM shops');
  stmt.step();
  const totalShops = stmt.getAsObject().count;
  stmt.free();

  stmt = db.prepare("SELECT COUNT(*) as count FROM records WHERE status = '未付'");
  stmt.step();
  const unpayCount = stmt.getAsObject().count;
  stmt.free();

  stmt = db.prepare('SELECT COALESCE(SUM(money), 0) as total FROM records');
  stmt.step();
  const totalSpent = stmt.getAsObject().total;
  stmt.free();

  stmt = db.prepare('SELECT shop, ROUND(SUM(money), 2) as total FROM records GROUP BY shop ORDER BY total DESC LIMIT 10');
  const topShops = [];
  while (stmt.step()) topShops.push(stmt.getAsObject());
  stmt.free();

  return { totalRecords, totalShops, unpayCount, totalSpent, topShops };
}

function getStockOverview(date) {
  // 获取该日所有不重复食品
  const foodSet = new Set();

  // 从进货记录获取
  let stmt = db.prepare('SELECT DISTINCT food FROM records WHERE date = ? AND type = ?', [date, '自采']);
  while (stmt.step()) foodSet.add(stmt.getAsObject().food);
  stmt.free();

  // 从销售记录获取
  stmt = db.prepare('SELECT DISTINCT food FROM sales WHERE date = ?', [date]);
  while (stmt.step()) foodSet.add(stmt.getAsObject().food);
  stmt.free();

  // 从后厨领用获取
  stmt = db.prepare('SELECT DISTINCT food FROM records WHERE date = ? AND type = ?', [date, '后厨']);
  while (stmt.step()) foodSet.add(stmt.getAsObject().food);
  stmt.free();

  // 从初始库存获取
  stmt = db.prepare('SELECT DISTINCT food FROM stock WHERE date = ?', [date]);
  while (stmt.step()) foodSet.add(stmt.getAsObject().food);
  stmt.free();

  const items = [];

  foodSet.forEach(food => {
    // 初始库存
    stmt = db.prepare('SELECT initStock FROM stock WHERE date = ? AND food = ?', [date, food]);
    let initStock = 0;
    if (stmt.step()) initStock = stmt.getAsObject().initStock;
    stmt.free();

    // 进货(自采)
    stmt = db.prepare('SELECT COALESCE(SUM(weight), 0) as w FROM records WHERE date = ? AND food = ? AND type = ?', [date, food, '自采']);
    stmt.step();
    const purchaseWeight = stmt.getAsObject().w;
    stmt.free();

    // 后厨领用
    stmt = db.prepare('SELECT COALESCE(SUM(weight), 0) as w FROM records WHERE date = ? AND food = ? AND type = ?', [date, food, '后厨']);
    stmt.step();
    const kitchenWeight = stmt.getAsObject().w;
    stmt.free();

    // 销售
    stmt = db.prepare('SELECT COALESCE(SUM(weight), 0) as w, COALESCE(SUM(amount), 0) as a FROM sales WHERE date = ? AND food = ?', [date, food]);
    stmt.step();
    const saleResult = stmt.getAsObject();
    const saleWeight = saleResult.w;
    const saleAmount = saleResult.a;
    stmt.free();

    const remaining = initStock + purchaseWeight - kitchenWeight - saleWeight;

    items.push({
      food,
      initStock: Math.round(initStock * 100) / 100,
      purchase: Math.round(purchaseWeight * 100) / 100,
      kitchen: Math.round(kitchenWeight * 100) / 100,
      sale: Math.round(saleWeight * 100) / 100,
      saleAmount: Math.round(saleAmount * 100) / 100,
      remaining: Math.round(remaining * 100) / 100
    });
  });

  items.sort((a, b) => b.purchase - a.purchase);

  return { date, items };
}

function clearAllRecords() {
  db.run('DELETE FROM records');
  saveDB();
}

function getAllRecordsForExport() {
  const stmt = db.prepare('SELECT * FROM records ORDER BY createdAt DESC');
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function getLocalDateStr(date) {
  if (!date) date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

function getLocalTimeStr(date) {
  if (!date) date = new Date();
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// ====== HTTP ======
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

function checkAdminAuth(req, res) {
  const auth = req.headers['authorization'];
  if (!auth) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="admin"'
    });
    res.end();
    return false;
  }

  try {
    const base64 = auth.split(' ')[1];
    const decoded = Buffer.from(base64, 'base64').toString('utf8');
    const [user, pass] = decoded.split(':');

    if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="admin"'
      });
      res.end();
      return false;
    }

    return true;
  } catch {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="admin"'
    });
    res.end();
    return false;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');

// ====== 文件上传 ======
function handleUpload(req, res) {
  return new Promise((resolve) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const shopName = url.searchParams.get('shop') || 'general';
    const maxSize = 10 * 1024 * 1024; // 10MB
    let body = [];
    let bodyLength = 0;
    
    req.on('data', chunk => {
      bodyLength += chunk.length;
      if (bodyLength > maxSize) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '文件过大，最大 10MB' }));
        req.destroy();
        resolve();
        return;
      }
      body.push(chunk);
    });
    
    req.on('end', async () => {
      if (res.writableEnded) { resolve(); return; }
      
      const contentType = req.headers['content-type'] || '';
      
      if (contentType.includes('multipart/form-data')) {
        const raw = Buffer.concat(body);
        const parts = parseMultipart(raw, contentType);
        
        const results = [];
        for (const part of parts) {
          if (part.filename) {
            const ext = path.extname(part.filename).toLowerCase();
            const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
            if (!allowed.includes(ext)) continue;
            
            const saveDir = path.join(UPLOAD_DIR, 'shops', shopName);
            if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
            
            const uniqueName = Date.now() + '_' + crypto.randomBytes(4).toString('hex') + ext;
            const savePath = path.join(saveDir, uniqueName);
            fs.writeFileSync(savePath, part.data);
            
            const publicPath = 'uploads/shops/' + shopName + '/' + uniqueName;
            results.push({ path: publicPath, url: '/' + publicPath });
          }
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, files: results }));
        resolve();
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '只支持 multipart/form-data 上传' }));
        resolve();
      }
    });
    
    req.on('error', () => {
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '上传失败' }));
      }
      resolve();
    });
  });
}

function parseMultipart(raw, contentType) {
  const boundary = '--' + contentType.split('boundary=')[1];
  const parts = [];
  const sections = raw.toString('binary').split(boundary);
  
  for (const section of sections) {
    if (section.includes('Content-Disposition')) {
      const headerEnd = section.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      
      const headers = section.substring(0, headerEnd);
      const bodyBin = Buffer.from(section.substring(headerEnd + 4), 'binary');
      
      // 去掉末尾的 \r\n--
      const cleanBody = bodyBin.slice(0, bodyBin.length - 2 > 0 ? bodyBin.length - 2 : 0);
      
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      
      if (filenameMatch && filenameMatch[1]) {
        parts.push({
          filename: filenameMatch[1],
          data: cleanBody
        });
      }
    }
  }
  
  return parts;
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/portal.html';
  // 解码路径，支持中文文件/目录名
  try { urlPath = decodeURIComponent(urlPath); } catch {}
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
    if (pathname === '/api/shops' && method === 'GET') {
      return sendJSON(res, 200, { shops: getShops() });
    }

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

    // DELETE /api/shops/:name/certificates - 删除合格证（必须放在通配路由前面）
    if (method === 'DELETE' && /^\/api\/shops\/([^/]+)\/certificates$/.test(pathname)) {
      const m = pathname.match(/^\/api\/shops\/([^/]+)\/certificates$/);
      const name = decodeURIComponent(m[1]);
      const body = await parseBody(req);
      if (!body.filePath) return sendJSON(res, 400, { error: '缺少 filePath' });
      removeShopCertificate(name, body.filePath);
      return sendJSON(res, 200, { success: true });
    }

    if (pathname.startsWith('/api/shops/') && method === 'DELETE') {
      const name = decodeURIComponent(pathname.replace('/api/shops/', ''));
      deleteShop(name);
      return sendJSON(res, 200, { success: true });
    }

    // GET /api/shops/:name - 商家详情
    const shopDetailMatch = pathname.match(/^\/api\/shops\/([^/]+)$/);
    if (shopDetailMatch && method === 'GET') {
      const name = decodeURIComponent(shopDetailMatch[1]);
      const shop = getShop(name);
      if (!shop) return sendJSON(res, 404, { error: '商家不存在' });
      return sendJSON(res, 200, { shop });
    }

    // PUT /api/shops/:name - 更新商家信息
    if (shopDetailMatch && method === 'PUT') {
      const name = decodeURIComponent(shopDetailMatch[1]);
      const body = await parseBody(req);
      updateShop(name, body);
      return sendJSON(res, 200, { success: true });
    }

    // POST /api/shops/:name/certificates - 上传合格证
    if (method === 'POST' && /^\/api\/shops\/([^/]+)\/certificates$/.test(pathname)) {
      const m = pathname.match(/^\/api\/shops\/([^/]+)\/certificates$/);
      const name = decodeURIComponent(m[1]);
      const body = await parseBody(req);
      if (!body.filePath) return sendJSON(res, 400, { error: '缺少 filePath' });
      addShopCertificate(name, body.filePath);
      return sendJSON(res, 200, { success: true });
    }

    // POST /api/deposits - 新增押金记录（采购B退框）
    if (pathname === '/api/deposits' && method === 'POST') {
      const body = await parseBody(req);
      const { shop, bigBox, smallBox, amount, photo, buyer } = body;
      const now = new Date();
      const date = [now.getFullYear(), String(now.getMonth()+1).padStart(2,'0'), String(now.getDate()).padStart(2,'0')].join('/');
      const time = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
      db.run('INSERT INTO deposits (date, time, shop, action, bigBox, smallBox, amount, photo, buyer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [date, time, shop, 'return', bigBox || 0, smallBox || 0, amount || 0, photo || '', buyer || 'B']);
      saveDB();
      return sendJSON(res, 200, { success: true });
    }

    // GET /api/deposits - 查询押金记录
    if (pathname === '/api/deposits' && method === 'GET') {
      const date = url.searchParams.get('date');
      let sql = 'SELECT * FROM deposits';
      const params = [];
      if (date) { sql += ' WHERE date = ?'; params.push(date); }
      sql += ' ORDER BY id DESC';
      const stmt = db.prepare(sql);
      stmt.bind(params);
      const deposits = [];
      while (stmt.step()) deposits.push(stmt.getAsObject());
      stmt.free();
      return sendJSON(res, 200, { deposits });
    }

    // POST /api/upload - 上传图片
    if (pathname === '/api/upload' && method === 'POST') {
      return handleUpload(req, res);
    }

    if (pathname === '/api/records' && method === 'GET') {
      const filters = {
        date: url.searchParams.get('date'),
        shop: url.searchParams.get('shop'),
        status: url.searchParams.get('status'),
        type: url.searchParams.get('type')
      };
      return sendJSON(res, 200, { records: getRecords(filters), total: getAdminStats().totalRecords });
    }

    if (pathname === '/api/records' && method === 'POST') {
      const body = await parseBody(req);
      const { shop, food, weight, unit, price, money, status, type } = body;
      if (!shop || !food || !weight) {
        return sendJSON(res, 400, { error: '缺少必填字段' });
      }

      const now = new Date();
      const record = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        date: getLocalDateStr(now),
        time: getLocalTimeStr(now),
        shop, food,
        weight: parseFloat(weight),
        unit: unit || '斤',
        price: parseFloat(price),
        money: money ? Math.round(parseFloat(money) * 100) / 100 : Math.round(parseFloat(weight) * parseFloat(price) * 100) / 100,
        status: status || '未付',
        type: type || '自采'
      };

      addRecord(record);
      return sendJSON(res, 200, { success: true, record });
    }

    if (pathname === '/api/records' && method === 'DELETE') {
      clearAllRecords();
      return sendJSON(res, 200, { success: true });
    }

    if (pathname === '/api/records/pay-all' && method === 'PUT') {
      const count = payAllDebt();
      return sendJSON(res, 200, { success: true, count });
    }

    // PUT /api/records/pay-shop - 按商家结清
    if (pathname === '/api/records/pay-shop' && method === 'PUT') {
      const body = await parseBody(req);
      const { shop } = body;
      if (!shop) return sendJSON(res, 400, { error: '缺少商家名称' });
      const stmt = db.prepare("SELECT COUNT(*) as c FROM records WHERE shop = ? AND status = '未付'");
      stmt.bind([shop]);
      stmt.step();
      const count = stmt.getAsObject().c;
      stmt.free();
      db.run("UPDATE records SET status = '已付' WHERE shop = ? AND status = '未付'", [shop]);
      saveDB();
      return sendJSON(res, 200, { success: true, count });
    }

    const toggleMatch = pathname.match(/^\/api\/records\/([^/]+)\/toggle-status$/);
    if (toggleMatch && method === 'PUT') {
      const result = toggleRecordStatus(toggleMatch[1]);
      if (!result) return sendJSON(res, 404, { error: '记录不存在' });
      return sendJSON(res, 200, { success: true, record: result });
    }

    const deleteMatch = pathname.match(/^\/api\/records\/([^/]+)$/);
    if (deleteMatch && method === 'DELETE') {
      deleteRecord(deleteMatch[1]);
      return sendJSON(res, 200, { success: true });
    }

    if (pathname === '/api/records/match-prices' && method === 'PUT') {
      const count = matchKitchenPrices();
      return sendJSON(res, 200, { success: true, matched: count });
    }

    // PUT /api/records/:id - 更新记录字段
    const updateMatch = pathname.match(/^\/api\/records\/([^/]+)$/);
    if (updateMatch && method === 'PUT') {
      const id = updateMatch[1];
      const body = await parseBody(req);
      const fields = [];
      const values = [];
      if (body.price !== undefined) { fields.push('price = ?'); values.push(parseFloat(body.price)); }
      if (body.money !== undefined) { fields.push('money = ?'); values.push(parseFloat(body.money)); }
      if (body.status !== undefined) { fields.push('status = ?'); values.push(body.status); }
      if (fields.length === 0) return sendJSON(res, 400, { error: '没有可更新的字段' });
      values.push(id);
      db.run('UPDATE records SET ' + fields.join(', ') + ' WHERE id = ?', values);
      saveDB();
      return sendJSON(res, 200, { success: true });
    }

    if (pathname === '/api/summary' && method === 'GET') {
      return sendJSON(res, 200, getSummary());
    }

    if (pathname === '/api/dates' && method === 'GET') {
      return sendJSON(res, 200, { dates: getDates() });
    }

    if (pathname === '/api/export' && method === 'GET') {
      const all = getAllRecordsForExport();
      let csv = '\uFEFF日期,时间,商家,菜品,斤数,进价(元/斤),总金额(元),状态,用途\n';
      all.forEach(r => {
        csv += `${r.date},${r.time||''},${r.shop},${r.food},${r.weight},${r.price},${r.money},${r.status},${r.type||'自采'}\n`;
      });
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="生鲜台账_${new Date().toISOString().slice(0, 10)}.csv"`
      });
      return res.end(csv);
    }

    if (pathname === '/api/admin/stats' && method === 'GET') {
      return sendJSON(res, 200, getAdminStats());
    }

    // ====== 库存管理 API ======
    // POST /api/stock/import - 导入芯友 CSV
    if (pathname === '/api/stock/import' && method === 'POST') {
      const body = await parseBody(req);
      const { date, rows } = body;
      if (!date || !rows || !Array.isArray(rows)) return sendJSON(res, 400, { error: '缺少日期或数据' });

      let count = 0;
      // 先删除该日期已有的数据
      db.run('DELETE FROM sales WHERE date = ?', [date]);

      rows.forEach(row => {
        if (!row.food) return;
        db.run('INSERT INTO sales (date, shop, food, weight, unit, price, cost, amount, profit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [date, row.shop || '呱呱精品生鲜连锁店3店', row.food, parseFloat(row.weight) || 0, row.unit || 'kg', parseFloat(row.price) || 0, parseFloat(row.cost) || 0, parseFloat(row.amount) || 0, parseFloat(row.profit) || 0]);
        count++;
      });
      saveDB();
      return sendJSON(res, 200, { success: true, count });
    }

    // GET /api/stock/overview?date=X - 库存总览
    if (pathname === '/api/stock/overview' && method === 'GET') {
      const date = url.searchParams.get('date') || getLocalDateStr(new Date());
      return sendJSON(res, 200, getStockOverview(date));
    }

    // GET /api/stock/sales?date=X - 查看某天的销售数据
    if (pathname === '/api/stock/sales' && method === 'GET') {
      const date = url.searchParams.get('date');
      if (!date) return sendJSON(res, 400, { error: '缺少日期' });
      const stmt = db.prepare('SELECT * FROM sales WHERE date = ? ORDER BY food');
      stmt.bind([date]);
      const results = [];
      while (stmt.step()) results.push(stmt.getAsObject());
      stmt.free();
      return sendJSON(res, 200, { sales: results, total: results.length });
    }

    // POST /api/stock/init - 设置初始库存
    if (pathname === '/api/stock/init' && method === 'POST') {
      const body = await parseBody(req);
      const { date, food, weight, shop } = body;
      if (!date || !food || weight === undefined) return sendJSON(res, 400, { error: '缺少必填字段' });

      // 删除该菜品该日期的旧记录
      db.run('DELETE FROM stock WHERE date = ? AND food = ?', [date, food]);
      db.run('INSERT INTO stock (date, shop, food, initStock) VALUES (?, ?, ?, ?)', [date, shop || '呱呱精品生鲜连锁店3店', food, parseFloat(weight)]);
      saveDB();
      return sendJSON(res, 200, { success: true });
    }

    if (pathname === '/api/orders' && method === 'GET') {
      let targetDate = url.searchParams.get('targetDate');

      // 如果不传 targetDate,返回所有日期列表
      if (!targetDate) {
        const stmt = db.prepare('SELECT DISTINCT targetDate FROM orders ORDER BY targetDate DESC');
        const dates = [];
        while (stmt.step()) dates.push(stmt.getAsObject().targetDate);
        stmt.free();
        return sendJSON(res, 200, { dates: dates });
      }

      // 归一化:去掉日期的前导零
      targetDate = targetDate.replace(/(\d+)\/(\d+)\/(\d+)/, (m, y, m2, d) => y + '/' + String(parseInt(m2)) + '/' + String(parseInt(d)));

      const stmt = db.prepare('SELECT * FROM orders WHERE targetDate = ? ORDER BY createdAt DESC');
      stmt.bind([targetDate]);
      const results = [];
      while (stmt.step()) results.push(stmt.getAsObject());
      stmt.free();
      return sendJSON(res, 200, { orders: results, date: targetDate });
    }

    if (pathname === '/api/orders' && method === 'POST') {
      const body = await parseBody(req);
      const { food, weight, unit, remark, targetDate: manualDate } = body;
      if (!food || !weight) return sendJSON(res, 400, { error: '缺少必填字段' });

      const now = new Date();
      const time = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');

      // 支持前端传入日期,否则默认明天
      let targetDate;
      if (manualDate) {
        targetDate = manualDate;
      } else {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        targetDate = tomorrow.getFullYear() + '/' + String(tomorrow.getMonth()+1) + '/' + String(tomorrow.getDate());
      }

      db.run('INSERT INTO orders (food, weight, unit, targetDate, time, remark) VALUES (?, ?, ?, ?, ?, ?)',
        [food, parseFloat(weight), unit || '斤', targetDate, time, remark || '']);
      saveDB();

      return sendJSON(res, 200, { success: true });
    }

    if (pathname.startsWith('/api/orders/') && method === 'DELETE') {
      const id = pathname.replace('/api/orders/', '');
      db.run('DELETE FROM orders WHERE id = ?', [id]);
      saveDB();
      return sendJSON(res, 200, { success: true });
    }

    if (pathname === '/api/orders' && method === 'DELETE') {
      const targetDate = url.searchParams.get('targetDate');
      if (targetDate) {
        db.run('DELETE FROM orders WHERE targetDate = ?', [targetDate]);
      } else {
        db.run('DELETE FROM orders');
      }
      saveDB();
      return sendJSON(res, 200, { success: true });
    }

    if (pathname === '/api/localtime' && method === 'GET') {
      return sendJSON(res, 200, {
        serverTime: new Date().toISOString(),
        localDate: getLocalDateStr(new Date()),
        localTime: getLocalTimeStr(new Date())
      });
    }

    // 厨房后台
    if (pathname === '/kitchen' || pathname === '/kitchen.html') {
      return fs.readFile(path.join(__dirname, 'public', 'kitchen.html'), (err, d) => {
        if (err) return sendJSON(res, 404, { error: 'Kitchen page not found' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d);
      });
    }

    // 管理后台(不需要 Basic Auth,由前端自己登录)
    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      const adminFile = pathname === '/admin' ? '/admin.html' : pathname;
      const filePath = path.join(__dirname, 'public', adminFile);

      // 如果是普通文件请求,直接返回
      return fs.readFile(filePath, (err, d) => {
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
async function main() {
  await initDB();

  const server = http.createServer((req, res) => {
    const url = req.url;
    if (url.startsWith('/api/') || url.startsWith('/admin') || url.startsWith('/kitchen')) {
      handleAPI(req, res);
    } else {
      serveStatic(req, res);
    }
  });

  server.listen(PORT, () => {
    console.log(`\n🥬 生鲜台账服务已启动!`);
    console.log(`   前台记账: http://localhost:${PORT}/`);
    console.log(`   管理后台: http://localhost:${PORT}/admin`);
    console.log(`   数据库: ${DB_PATH}\n`);
  });
}

main().catch(e => {
  console.error('启动失败:', e);
  process.exit(1);
});
