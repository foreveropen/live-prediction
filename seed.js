// 初始化管理员账号
const db = require('./db');
const bcrypt = require('bcryptjs');

const exist = db.prepare("SELECT * FROM users WHERE username='gly123321'").get();
if (exist) {
  console.log('admin 已存在，id =', exist.id);
} else {
  const hash = bcrypt.hashSync('00001111', 8);
  const info = db.prepare("INSERT INTO users(username,password_hash,chips_balance,is_admin,created_at) VALUES(?,?,?,?,?)")
    .run('admin', hash, 999999, 1, Date.now());
  console.log('管理员创建成功: gly123321 / 00001111, id =', info.lastInsertRowid);
}
