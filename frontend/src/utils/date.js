/**
 * 日期处理工具函数
 */

/**
 * 格式化日期为 YYYY-MM-DD
 * @param {Date} d - 日期对象
 * @returns {string} 格式化后的日期字符串
 */
export function formatDateYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 获取默认交易日期（今天）
 * @returns {string} YYYY-MM-DD 格式的日期字符串
 */
export function getDefaultTradeDate() {
  return formatDateYMD(new Date());
}

/**
 * 构建交易时间字符串
 * @param {string} dateStr - 日期字符串 (YYYY-MM-DD)
 * @param {string} cutoff - 交易时段 ('before' | 'after')
 * @returns {string} ISO 格式的时间字符串
 */
export function buildTradeTime(dateStr, cutoff) {
  if (cutoff !== 'before' && cutoff !== 'after') {
    throw new Error(`Invalid cutoff: ${cutoff}. Must be 'before' or 'after'.`);
  }
  const time = cutoff === 'after' ? '15:01:00' : '14:59:00';
  return `${dateStr}T${time}`;
}
