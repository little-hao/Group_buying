/**
 * 拼单账本 - 通用工具
 */

const formatNumber = (n) => {
  n = n.toString()
  return n[1] ? n : `0${n}`
}

/**
 * 格式化时间：YYYY-MM-DD HH:mm
 *
 * @param {Date} date 日期对象
 * @returns {String}
 */
const formatTime = (date) => {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hour = date.getHours()
  const minute = date.getMinutes()

  return `${[year, month, day].map(formatNumber).join('-')} ${[hour, minute].map(formatNumber).join(':')}`
}

module.exports = {
  formatTime
}