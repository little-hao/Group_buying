/**
 * 微信服务端接口封装
 *
 * - code2Session：用 wx.login 的 code 换 openid（需要 AppID/AppSecret）。
 * - access_token：用于订阅消息与小程序码，内存缓存，过期自动刷新。
 * - sendSubscribe / wxacode：成员核销通知与邀请小程序码。
 * - 开发模式：ALLOW_DEV_LOGIN=true 时可不依赖 AppSecret 直连测试。
 */
const https = require('https')
const crypto = require('crypto')

const APPID = process.env.WEAPP_APPID || ''
const SECRET = process.env.WEAPP_SECRET || ''
const ALLOW_DEV = process.env.ALLOW_DEV_LOGIN === 'true'
const DEV_OPENID = process.env.DEV_OPENID || 'dev_openid'

let cachedToken = null
let tokenExpiresAt = 0

function requestJson(method, host, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : ''
    const req = https.request({
      host,
      path: pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(text))
        } catch (error) {
          resolve({ errcode: -1, errmsg: text })
        }
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function code2Session(code) {
  if (!code) throw new Error('缺少 wx.login code')
  if (ALLOW_DEV || !APPID || !SECRET) {
    // 开发模式：固定测试 openid，方便本地联调；生产必须配置 AppID/Secret。
    return { openid: DEV_OPENID, session_key: 'dev' }
  }

  const query = new URLSearchParams({
    appid: APPID,
    secret: SECRET,
    js_code: code,
    grant_type: 'authorization_code'
  })
  const data = await requestJson('GET', 'api.weixin.qq.com', `/sns/jscode2session?${query}`)
  if (!data.openid) {
    throw new Error(`jscode2session 失败：${data.errmsg || '未知错误'}`)
  }
  return data
}

async function getAccessToken() {
  if (!APPID || !SECRET) throw new Error('未配置 WEAPP_APPID / WEAPP_SECRET')
  const now = Date.now()
  if (cachedToken && tokenExpiresAt > now + 60000) return cachedToken

  const query = new URLSearchParams({
    grant_type: 'client_credential',
    appid: APPID,
    secret: SECRET
  })
  const data = await requestJson('GET', 'api.weixin.qq.com', `/cgi-bin/token?${query}`)
  if (!data.access_token) throw new Error(`access_token 获取失败：${data.errmsg || '未知错误'}`)
  cachedToken = data.access_token
  tokenExpiresAt = now + (data.expires_in || 7200) * 1000
  return cachedToken
}

async function sendSubscribe({ openid, templateId, page, data }) {
  if (!templateId) return { ok: false, message: '未配置订阅消息模板 ID' }
  try {
    const token = await getAccessToken()
    const result = await requestJson('POST', 'api.weixin.qq.com',
      `/cgi-bin/message/subscribe/send?access_token=${token}`, {
        touser: openid,
        template_id: templateId,
        page,
        data
      })
    if (result.errcode) {
      return { ok: false, message: result.errmsg || `微信错误 ${result.errcode}` }
    }
    return { ok: true, message: '' }
  } catch (error) {
    return { ok: false, message: error.message || '订阅消息发送失败' }
  }
}

async function wxacode({ scene, page, envVersion }) {
  const token = await getAccessToken()
  const body = { scene, page, check_path: false, env_version: envVersion || 'release' }

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = https.request({
      host: 'api.weixin.qq.com',
      path: `/wxa/getwxacodeunlimit?access_token=${token}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const buffer = Buffer.concat(chunks)
        const contentType = res.headers['content-type'] || ''
        if (contentType.indexOf('json') !== -1) {
          try {
            reject(new Error(JSON.parse(buffer.toString()).errmsg || '小程序码生成失败'))
          } catch (error) {
            reject(error)
          }
          return
        }
        resolve(buffer.toString('base64'))
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex')
}

module.exports = {
  code2Session,
  getAccessToken,
  sendSubscribe,
  wxacode,
  randomToken
}