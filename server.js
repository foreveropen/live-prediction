const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');
const sse = require('./lib/sse');
const { calcProfit } = require('./lib/settlement');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============ 工具 ============
function signToken(user) {
  return jwt.sign({ uid: user.id, username: user.username, isAdmin: !!user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
}

// 认证中间件：挂载 req.user，不强制拦截（/me 友好降级）
function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(200).json({ code: 401, message: '未登录' });
  try {
    const payload = jwt.verify(h.slice(7), JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(payload.uid);
    if (!user) return res.status(200).json({ code: 401, message: '用户不存在' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(200).json({ code: 401, message: '登录已失效' });
  }
}

function adminRequired(req, res, next) {
  authRequired(req, res, () => {
    if (!req.user.is_admin) return res.status(200).json({ code: 403, message: '需要管理员权限' });
    next();
  });
}

function writeChipLog(userId, type, amount, balanceAfter, frozenAfter, ref, note) {
  db.prepare(`INSERT INTO chip_logs(user_id,type,amount,balance_after,frozen_after,ref,note,created_at)
              VALUES(?,?,?,?,?,?,?,?)`).run(
    userId, type, amount, balanceAfter, frozenAfter, ref || '', note || '', Date.now()
  );
}

// 组装预言列表项（带双方筹码、我的投注）
function shapePrediction(p, currentUserId) {
  const agg = db.prepare(`SELECT side, SUM(amount) AS total FROM bets WHERE prediction_id=? GROUP BY side`).all(p.id);
  const poolA = (agg.find(a => a.side === 'A') || { total: 0 }).total;
  const poolB = (agg.find(a => a.side === 'B') || { total: 0 }).total;
  const myBet = currentUserId
    ? db.prepare('SELECT * FROM bets WHERE prediction_id=? AND user_id=?').get(p.id, currentUserId)
    : null;
  return {
    id: p.id,
    title: p.title,
    optionA: p.option_a,
    optionB: p.option_b,
    status: p.status,
    minBet: p.min_bet,
    maxBet: p.max_bet,
    sealAt: p.seal_at,
    settledSide: p.settled_side,
    settledAt: p.settled_at,
    isTop: !!p.is_top,
    poolA, poolB,
    totalPool: poolA + poolB,
    myBet: myBet ? { side: myBet.side, amount: myBet.amount, profit: myBet.profit } : null
  };
}

// ============ 认证 ============
app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || username.length < 2 || password.length < 4) {
    return res.json({ code: 400, message: '用户名至少2位，密码至少4位' });
  }
  const exist = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (exist) return res.json({ code: 400, message: '用户名已存在' });
  const hash = bcrypt.hashSync(password, 8);
  const info = db.prepare('INSERT INTO users(username,password_hash,chips_balance,created_at) VALUES(?,?,?,?)')
    .run(username, hash, 1000, Date.now());
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  writeChipLog(user.id, 'register', 1000, 1000, 0, '', '新用户赠送初始筹码');
  res.json({ code: 200, data: { token: signToken(user), user: publicUser(user) } });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username || '');
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.json({ code: 400, message: '用户名或密码错误' });
  }
  res.json({ code: 200, data: { token: signToken(user), user: publicUser(user) } });
});

// /me 统一 HTTP 200，业务 code 区分
app.get('/api/auth/me', (req, res) => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.json({ code: 401, message: '未登录' });
  try {
    const payload = jwt.verify(h.slice(7), JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(payload.uid);
    if (!user) return res.json({ code: 401, message: '用户不存在' });
    res.json({ code: 200, data: publicUser(user) });
  } catch (e) {
    res.json({ code: 401, message: '登录已失效' });
  }
});

function publicUser(u) {
  return { id: u.id, username: u.username, chips: u.chips_balance, frozen: u.chips_frozen, level: u.level, isAdmin: !!u.is_admin };
}

// ============ 预言 ============
app.get('/api/predictions', (req, res) => {
  let uid = null;
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    try { uid = jwt.verify(h.slice(7), JWT_SECRET).uid; } catch (e) {}
  }
  const rows = db.prepare(`SELECT * FROM predictions ORDER BY is_top DESC, id DESC`).all();
  res.json({ code: 200, data: rows.map(r => shapePrediction(r, uid)) });
});

// 创建预言（管理员）
app.post('/api/predictions', adminRequired, (req, res) => {
  const { title, optionA, optionB, minutes, minBet, maxBet } = req.body || {};
  if (!title || !optionA || !optionB) return res.json({ code: 400, message: '标题和选项不能为空' });
  const sealAt = minutes ? Date.now() + Number(minutes) * 60 * 1000 : null;
  const info = db.prepare(`INSERT INTO predictions(title,option_a,option_b,status,min_bet,max_bet,seal_at,created_by,created_at)
                           VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(title, optionA, optionB, 'active', minBet || 10, maxBet || 10000, sealAt, req.user.id, Date.now());
  const p = db.prepare('SELECT * FROM predictions WHERE id=?').get(info.lastInsertRowid);
  sse.broadcast('prediction:new', shapePrediction(p, null));
  res.json({ code: 200, data: shapePrediction(p, req.user.id) });
});

// 提前封盘
app.post('/api/predictions/:id/seal', adminRequired, (req, res) => {
  const p = db.prepare('SELECT * FROM predictions WHERE id=?').get(req.params.id);
  if (!p) return res.json({ code: 404, message: '预言不存在' });
  if (p.status !== 'active') return res.json({ code: 400, message: '当前状态不能封盘' });
  db.prepare("UPDATE predictions SET status='sealed', seal_at=? WHERE id=?").run(Date.now(), p.id);
  sse.broadcast('prediction:sealed', { id: p.id });
  res.json({ code: 200 });
});

// 结算
app.post('/api/predictions/:id/settle', adminRequired, (req, res) => {
  const { side } = req.body || {};
  if (!['A', 'B'].includes(side)) return res.json({ code: 400, message: '请选择正确答案 A 或 B' });
  const p = db.prepare('SELECT * FROM predictions WHERE id=?').get(req.params.id);
  if (!p) return res.json({ code: 404, message: '预言不存在' });
  if (p.status !== 'sealed' && p.status !== 'active') return res.json({ code: 400, message: '当前状态不能结算' });

  const otherSide = side === 'A' ? 'B' : 'A';
  const winPoolRow = db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM bets WHERE prediction_id=? AND side=?`).get(p.id, side);
  const losePoolRow = db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM bets WHERE prediction_id=? AND side=?`).get(p.id, otherSide);
  const winPool = winPoolRow.s;
  const losePool = losePoolRow.s;

  const tx = db.transaction(() => {
    // 1. 失败方：本金输掉（冻结清零，balance 不返还）
    const losers = db.prepare('SELECT * FROM bets WHERE prediction_id=? AND side=?').all(p.id, otherSide);
    for (const b of losers) {
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(b.user_id);
      const newFrozen = u.chips_frozen - b.amount;
      db.prepare('UPDATE users SET chips_frozen=? WHERE id=?').run(newFrozen, u.id);
      db.prepare('UPDATE bets SET profit=? WHERE id=?').run(-b.amount, b.id);
      writeChipLog(u.id, 'bet_lose', -b.amount, u.chips_balance, newFrozen, 'prediction:' + p.id, '未命中，本金扣除');
    }
    // 2. 获胜方：解冻本金 + 按彩池比例分盈利
    const winners = db.prepare('SELECT * FROM bets WHERE prediction_id=? AND side=?').all(p.id, side);
    for (const b of winners) {
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(b.user_id);
      let profit;
      if (losePool <= 0) {
        profit = 0; // 所有人都猜对，无分红，只返本金
      } else if (winPool <= 0) {
        profit = 0; // 理论上不会进这（winPool 至少 >= b.amount）
      } else {
        profit = calcProfit(winPool, losePool, b.amount);
      }
      const newFrozen = u.chips_frozen - b.amount;
      const newBalance = u.chips_balance + b.amount + profit;
      db.prepare('UPDATE users SET chips_balance=?, chips_frozen=? WHERE id=?').run(newBalance, newFrozen, u.id);
      db.prepare('UPDATE bets SET profit=? WHERE id=?').run(profit, b.id);
      writeChipLog(u.id, 'bet_win', b.amount + profit, newBalance, newFrozen, 'prediction:' + p.id, `命中，返还本金${b.amount}+盈利${profit}`);
    }
    // 3. 更新预言状态
    db.prepare("UPDATE predictions SET status='settled', settled_side=?, settled_at=? WHERE id=?").run(side, Date.now(), p.id);
  });
  tx();

  const settled = db.prepare('SELECT * FROM predictions WHERE id=?').get(p.id);
  sse.broadcast('prediction:settled', shapePrediction(settled, null));
  res.json({ code: 200, data: { winPool, losePool } });
});

// 作废：全额返还冻结筹码
app.post('/api/predictions/:id/void', adminRequired, (req, res) => {
  const p = db.prepare('SELECT * FROM predictions WHERE id=?').get(req.params.id);
  if (!p) return res.json({ code: 404, message: '预言不存在' });
  if (p.status === 'settled' || p.status === 'voided') return res.json({ code: 400, message: '已结算/已作废不能再操作' });
  const tx = db.transaction(() => {
    const bets = db.prepare('SELECT * FROM bets WHERE prediction_id=?').all(p.id);
    for (const b of bets) {
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(b.user_id);
      const newFrozen = u.chips_frozen - b.amount;
      const newBalance = u.chips_balance + b.amount;
      db.prepare('UPDATE users SET chips_balance=?, chips_frozen=? WHERE id=?').run(newBalance, newFrozen, u.id);
      writeChipLog(u.id, 'void_refund', b.amount, newBalance, newFrozen, 'prediction:' + p.id, '预言作废，筹码原路退回');
    }
    db.prepare("UPDATE predictions SET status='voided' WHERE id=?").run(p.id);
    db.prepare("UPDATE bets SET profit=0 WHERE prediction_id=?").run(p.id);
  });
  tx();
  const v = db.prepare('SELECT * FROM predictions WHERE id=?').get(p.id);
  sse.broadcast('prediction:voided', shapePrediction(v, null));
  res.json({ code: 200 });
});

// 置顶切换
app.post('/api/predictions/:id/top', adminRequired, (req, res) => {
  db.prepare('UPDATE predictions SET is_top = 1 - is_top WHERE id=?').run(req.params.id);
  res.json({ code: 200 });
});

// ============ 投注 ============
app.post('/api/predictions/:id/bet', authRequired, (req, res) => {
  const { side, amount } = req.body || {};
  const p = db.prepare('SELECT * FROM predictions WHERE id=?').get(req.params.id);
  if (!p) return res.json({ code: 404, message: '预言不存在' });
  if (p.status !== 'active') return res.json({ code: 400, message: '当前不可参与' });
  if (p.seal_at && p.seal_at < Date.now()) return res.json({ code: 400, message: '已封盘' });
  if (!['A', 'B'].includes(side)) return res.json({ code: 400, message: '请选择 A 或 B' });
  const amt = Math.floor(Number(amount));
  if (!amt || amt <= 0) return res.json({ code: 400, message: '请输入有效筹码数' });
  if (amt < p.min_bet || amt > p.max_bet) return res.json({ code: 400, message: `单笔需在 ${p.min_bet} ~ ${p.max_bet} 之间` });

  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (u.chips_balance < amt) return res.json({ code: 400, message: '筹码不足' });
  const exist = db.prepare('SELECT id FROM bets WHERE prediction_id=? AND user_id=?').get(p.id, u.id);
  if (exist) return res.json({ code: 400, message: '单条预言仅可参与一次' });

  const tx = db.transaction(() => {
    const newBalance = u.chips_balance - amt;
    const newFrozen = u.chips_frozen + amt;
    db.prepare('UPDATE users SET chips_balance=?, chips_frozen=? WHERE id=?').run(newBalance, newFrozen, u.id);
    db.prepare('INSERT INTO bets(user_id,prediction_id,side,amount,created_at) VALUES(?,?,?,?,?)')
      .run(u.id, p.id, side, amt, Date.now());
    writeChipLog(u.id, 'bet_freeze', -amt, newBalance, newFrozen, 'prediction:' + p.id, `投入 ${amt} 筹码`);
  });
  tx();

  const fresh = db.prepare('SELECT * FROM predictions WHERE id=?').get(p.id);
  sse.broadcast('prediction:updated', shapePrediction(fresh, null));
  res.json({ code: 200, data: shapePrediction(fresh, u.id) });
});

// ============ 历史 ============
app.get('/api/history', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, p.title, p.option_a, p.option_b, p.status, p.settled_side, p.settled_at
    FROM bets b JOIN predictions p ON p.id = b.prediction_id
    WHERE b.user_id=? ORDER BY b.id DESC
  `).all(req.user.id);
  const data = rows.map(b => {
    let result = 'pending';
    if (b.status === 'voided') result = 'voided';
    else if (b.status === 'settled') {
      result = (b.settled_side === b.side) ? 'win' : 'lose';
    }
    return {
      id: b.id, title: b.title, side: b.side, amount: b.amount,
      optionA: b.option_a, optionB: b.option_b,
      settledSide: b.settled_side, result, profit: b.profit,
      createdAt: b.created_at
    };
  });
  res.json({ code: 200, data });
});

// 管理员加筹码（调试用）
app.post('/api/admin/give', adminRequired, (req, res) => {
  const { userId, amount } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!u) return res.json({ code: 404, message: '用户不存在' });
  const newBalance = u.chips_balance + Number(amount);
  db.prepare('UPDATE users SET chips_balance=? WHERE id=?').run(newBalance, u.id);
  writeChipLog(u.id, 'admin_adjust', Number(amount), newBalance, u.chips_frozen, '', '管理员调整');
  res.json({ code: 200 });
});

// ============ SSE ============
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write(': connected\n\n');
  sse.addClient(res);
});

// ============ 启动 ============
app.listen(PORT, () => {
  console.log(`预言竞猜系统已启动: http://localhost:${PORT}`);
});
