// 临时验证：历史接口 SQL 是否正常
const db = require('../db');
const bcrypt = require('bcryptjs');
const hash = bcrypt.hashSync('1234', 8);
db.prepare('INSERT OR IGNORE INTO users(username,password_hash,chips_balance,created_at) VALUES(?,?,?,?)')
  .run('audit_test', hash, 1000, Date.now());
const u = db.prepare("SELECT * FROM users WHERE username='audit_test'").get();
console.log('user id =', u.id);

const rows = db.prepare(`
  SELECT b.*, p.title, p.option_a, p.option_b, p.status, p.settled_side, p.settled_at
  FROM bets b JOIN predictions p ON p.id = b.prediction_id
  WHERE b.user_id=? ORDER BY b.id DESC
`).all(u.id);
console.log('history SQL OK, rows =', rows.length);
console.log('验证通过，没有 SQL 错误');
