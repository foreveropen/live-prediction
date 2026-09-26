// 冒烟测试：1000轮随机场景，校验筹码守恒和业务规则
const BASE = 'http://localhost:3000';
const db = require('../db');

let adminToken = '';
const users = []; // {token, id, name}

const log = [];
function record(msg) { log.push(msg); }

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }

async function main() {
  console.log('=== 开始冒烟测试 ===\n');

  // 1. 管理员登录
  const login = await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  adminToken = login.data.token;
  console.log('[1] 管理员登录成功');

  // 2. 注册 50 个用户
  for (let i = 0; i < 50; i++) {
    const r = await api('/api/auth/register', { method: 'POST', body: { username: `u${Date.now()}_${i}`, password: '1234' } });
    users.push({ token: r.data.token, id: r.data.user.id, name: r.data.user.username });
  }
  console.log(`[2] 注册 ${users.length} 个用户，各送 1000 筹码`);

  // 记录初始总筹码
  const initialTotal = db.prepare('SELECT COALESCE(SUM(chips_balance + chips_frozen),0) AS s FROM users').get().s;
  console.log(`[3] 初始总筹码（含管理员）: ${initialTotal}\n`);

  // 3. 跑 1000 轮
  const stats = { total: 0, settled: 0, voided: 0, betSuccess: 0, betRejected: 0, errors: [] };
  const ROUNDS = 1000;

  for (let round = 1; round <= ROUNDS; round++) {
    stats.total++;
    try {
      // 创建预言
      const pred = await api('/api/predictions', {
        method: 'POST', token: adminToken,
        body: { title: `冒烟轮次${round}`, optionA: '是', optionB: '否', minutes: 30, minBet: 10, maxBet: 5000 }
      });
      const pid = pred.data.id;

      // 随机 1-8 个用户下注
      const betCount = randInt(1, 8);
      const betters = [...users].sort(() => Math.random() - 0.5).slice(0, betCount);
      for (const u of betters) {
        const side = Math.random() < 0.5 ? 'A' : 'B';
        const amount = pick([10, 20, 50, 100, 200, 500]);
        const r = await api(`/api/predictions/${pid}/bet`, { method: 'POST', token: u.token, body: { side, amount } });
        if (r.code === 200) stats.betSuccess++;
        else stats.betRejected++;
      }

      // 随机决定结局：80%结算，20%作废
      const doVoid = Math.random() < 0.2;
      if (doVoid) {
        await api(`/api/predictions/${pid}/void`, { method: 'POST', token: adminToken });
        stats.voided++;
      } else {
        // 先封盘再结算
        await api(`/api/predictions/${pid}/seal`, { method: 'POST', token: adminToken });
        const side = Math.random() < 0.5 ? 'A' : 'B';
        const r = await api(`/api/predictions/${pid}/settle`, { method: 'POST', token: adminToken, body: { side } });
        if (r.code !== 200) stats.errors.push(`轮次${round}结算失败: ${r.message}`);
        stats.settled++;
      }

      if (round % 100 === 0) console.log(`  进度: ${round}/${ROUNDS} (结算${stats.settled} 作废${stats.voided})`);
    } catch (e) {
      stats.errors.push(`轮次${round}异常: ${e.message}`);
    }
  }

  console.log(`\n[4] ${ROUNDS} 轮完成`);

  // 4. 最终校验
  console.log('\n=== 数据校验 ===');

  // 4.1 所有用户余额非负
  const negUsers = db.prepare('SELECT id,username,chips_balance,chips_frozen FROM users WHERE chips_balance < 0 OR chips_frozen < 0').all();
  console.log(`[校验] 余额/冻结为负的用户数: ${negUsers.length} ${negUsers.length ? JSON.stringify(negUsers) : '✓'}`);

  // 4.2 所有结算/作废预言，相关 bet 的 profit 不为 null
  const unresolvedBets = db.prepare(`
    SELECT b.id, b.prediction_id, p.status FROM bets b
    JOIN predictions p ON p.id = b.prediction_id
    WHERE p.status IN ('settled','voided') AND b.profit IS NULL
  `).all();
  console.log(`[校验] 已结束但 profit 未结算的投注: ${unresolvedBets.length} ${unresolvedBets.length ? JSON.stringify(unresolvedBets) : '✓'}`);

  // 4.3 所有结束预言，相关用户 frozen 已释放
  const frozenLeftover = db.prepare(`
    SELECT DISTINCT u.id, u.username, u.chips_frozen FROM users u
    JOIN bets b ON b.user_id = u.id
    JOIN predictions p ON p.id = b.prediction_id
    WHERE p.status IN ('settled','voided') AND u.chips_frozen > 0
  `).all();
  // 注意：用户可能同时有进行中的预言冻结，所以这个数字不一定为0，只看是否有已结束预言残留
  console.log(`[校验] 结束预言后仍有冻结的用户（可能因其他进行中预言）: ${frozenLeftover.length}`);

  // 4.4 筹码守恒：当前用户总筹码 + 平台回收 = 初始总筹码
  const currentTotal = db.prepare('SELECT COALESCE(SUM(chips_balance + chips_frozen),0) AS s FROM users').get().s;
  // 平台回收 = 所有 settled 预言里，失败方输掉的筹码 - 获胜方分走的盈利
  // 失败方输掉 = bets where side != settled_side, profit = -amount, sum(-profit)
  const platformCollected = db.prepare(`
    SELECT COALESCE(SUM(-b.profit),0) AS lost FROM bets b
    JOIN predictions p ON p.id = b.prediction_id
    WHERE p.status='settled' AND b.side != p.settled_side
  `).get().lost;
  const winnersProfit = db.prepare(`
    SELECT COALESCE(SUM(b.profit),0) AS won FROM bets b
    JOIN predictions p ON p.id = b.prediction_id
    WHERE p.status='settled' AND b.side = p.settled_side AND b.profit > 0
  `).get().won;
  // 实际平台回收 = 失败方输掉的总筹码 - 获胜方分走的盈利
  const platformKept = platformCollected - winnersProfit;
  const finalTotal = currentTotal + platformKept;
  console.log(`\n[筹码守恒]`);
  console.log(`  初始总筹码:       ${initialTotal}`);
  console.log(`  当前用户持有:     ${currentTotal}`);
  console.log(`  失败方输掉总额:   ${platformCollected}`);
  console.log(`  获胜方分走盈利:   ${winnersProfit}`);
  console.log(`  平台回收(余数):   ${platformKept}`);
  console.log(`  当前+平台回收:    ${finalTotal}`);
  console.log(`  守恒校验:         ${finalTotal === initialTotal ? '✓ 平衡' : '✗ 不平衡，差额=' + (initialTotal - finalTotal)}`);

  // 4.5 重复投注检查（唯一索引）
  const dupBets = db.prepare('SELECT user_id, prediction_id, COUNT(*) c FROM bets GROUP BY user_id, prediction_id HAVING c > 1').all();
  console.log(`[校验] 重复投注（应被唯一索引拦截）: ${dupBets.length} ${dupBets.length ? '✗' : '✓'}`);

  // 4.6 流水日志数
  const logCount = db.prepare('SELECT COUNT(*) c FROM chip_logs').get().c;
  console.log(`[信息] 筹码流水日志条数: ${logCount}`);

  // 5. 汇总
  console.log('\n=== 测试汇总 ===');
  console.log(`总轮次: ${stats.total}`);
  console.log(`  结算: ${stats.settled}`);
  console.log(`  作废: ${stats.voided}`);
  console.log(`投注成功: ${stats.betSuccess}`);
  console.log(`投注被拒: ${stats.betRejected}`);
  console.log(`错误数: ${stats.errors.length}`);
  if (stats.errors.length) console.log('错误详情:\n' + stats.errors.slice(0, 10).join('\n'));

  console.log('\n=== 冒烟测试完成 ===');
}

main().catch(e => { console.error('测试脚本异常:', e); process.exit(1); });
