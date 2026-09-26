// 结算引擎 - 严格按 PRD 彩池分红规则
// 总彩池 = A总 + B总
// 失败奖金池 = 失败方总筹码
// 个人盈利 = floor(失败奖金池 × 个人投注 / 获胜方总筹码)
// 到手 = 本金 + 盈利
// 余数平台回收

/**
 * 计算单个获胜用户的盈利
 * @param {number} winningPool  获胜方总筹码
 * @param {number} losingPool   失败方总筹码
 * @param {number} userBet      该用户获胜方投注额
 * @returns {number} 盈利（向下取整，不含本金）
 */
function calcProfit(winningPool, losingPool, userBet) {
  if (winningPool <= 0) return 0;       // 无人押中此分支不会走到（见上层兜底）
  if (losingPool <= 0) return 0;        // 所有人都猜对，无分红
  return Math.floor((losingPool * userBet) / winningPool);
}

module.exports = { calcProfit };
