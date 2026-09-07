/**
 * 拼单账本 - VPS 自建 API
 *
 * 运行：node server.js（aaPanel Node 项目或 pm2 守护）
 * 依赖：仅 express；数据存 data/*.json；头像等对象存 objects/。
 *
 * 环境变量：
 * - PORT           默认 3000
 * - WEAPP_APPID    小程序 AppID（wx.login 换 openid 用）
 * - WEAPP_SECRET   小程序 AppSecret
 * - ADMIN_OPENIDS  后台管理员 openid 列表，逗号分隔
 * - SUBSCRIBE_TEMPLATE_ID 订阅消息模板 ID
 * - PUBLIC_BASE_URL 对外文件 URL 前缀，默认 https://hao.19990920.xyz/api
 * - DATA_DIR / OBJECT_DIR 可覆盖存储目录
 * - ALLOW_DEV_LOGIN=true + DEV_OPENID=xxx 开发模式免 AppSecret
 */
const path = require('path')
const fs = require('fs')
const express = require('express')
const { JsonStore } = require('./lib/store')
const wechat = require('./lib/wechat')

const PORT = Number(process.env.PORT || 3000)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
const OBJECT_DIR = process.env.OBJECT_DIR || path.join(__dirname, 'objects')
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://hao.19990920.xyz/api').replace(/\/+$/, '')
const ADMIN_OPENIDS = (process.env.ADMIN_OPENIDS || '').split(',').map((x) => x.trim()).filter(Boolean)
const SUBSCRIBE_TEMPLATE_ID = process.env.SUBSCRIBE_TEMPLATE_ID || 'CAlj2-_f5pFaXLaNIP_3JRnWq5cDPrc1XNUui1ebDPk'

fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(OBJECT_DIR, { recursive: true })

const store = new JsonStore(DATA_DIR)
store.init()

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '12mb' }))
app.use('/files', express.static(OBJECT_DIR, { maxAge: '7d' }))

/* ================= 工具函数 ================= */

const now = () => Date.now()
const countValue = (value, fallback = 0) => {
  const number = parseInt(value, 10)
  return Number.isFinite(number) ? number : fallback
}
const cleanText = (value, fallback = '') => String(value || '').trim() || fallback
const boolValue = (value) => value === true || value === 'true' || value === 1
const makeId = (prefix) => store.id(prefix)
const formatTime = (timestamp) => {
  const date = new Date(timestamp)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const getUser = (openid) => store.one('users', (item) => item.openid === openid)
const getBook = (bookId) => store.one('books', (item) => item._id === bookId)
const isPlatform = (openid) => ADMIN_OPENIDS.indexOf(openid) !== -1 ||
  !!(getUser(openid) && getUser(openid).platformAdmin)

function getAccess(book, openid) {
  if (!book) return null
  if (book.ownerOpenid === openid) {
    return { role: 'owner', canManage: true, canConsume: true, canGrant: true, member: null }
  }
  if (isPlatform(openid)) {
    return { role: 'platform', canManage: true, canConsume: true, canGrant: true, member: null }
  }
  const member = store.one('members', (item) => item.bookId === book._id && item.userOpenid === openid)
  if (!member) return null
  const consume = !!(member.permissions && member.permissions.consume)
  const manage = !!(member.permissions && member.permissions.manage)
  return {
    role: manage ? 'manager' : 'member',
    canManage: manage,
    canConsume: consume || manage,
    canGrant: false,
    member
  }
}

function toMember(member, openid, options = {}) {
  const permissions = (member && member.permissions) || {}
  return {
    id: member._id,
    name: member.name || '未命名成员',
    totalCount: countValue(member.totalCount),
    usedCount: countValue(member.usedCount),
    remainingCount: countValue(member.remainingCount),
    userId: member.userOpenid || '',
    bound: !!member.userOpenid,
    isMe: !!member.userOpenid && member.userOpenid === openid,
    inviteCode: options.showInvite ? member.inviteCode || '' : '',
    permissions: { consume: !!permissions.consume, manage: !!permissions.manage },
    createTime: member.createTime || 0
  }
}

function toBill(bill) {
  return {
    id: bill._id,
    type: bill.type || 'consume',
    memberId: bill.memberId || '',
    memberName: bill.memberName || '',
    count: countValue(bill.count),
    amountText: bill.amountText || '',
    title: bill.title || '',
    remark: bill.remark || '',
    operatorUserId: bill.operatorOpenid || '',
    timeText: bill.timeText || formatTime(bill.time || 0),
    time: bill.time || 0
  }
}

function toNotification(item) {
  return {
    id: item._id,
    type: item.type || 'consume',
    memberId: item.memberId || '',
    memberName: item.memberName || '',
    count: countValue(item.count),
    remark: item.remark || '',
    timeText: item.timeText || formatTime(item.time || 0),
    time: item.time || 0,
    read: !!item.read,
    subscribe: item.subscribe || null
  }
}

function toBook(book) {
  return {
    id: book._id,
    name: book.name || '未命名账本',
    ownerOpenid: book.ownerOpenid || '',
    totalCount: countValue(book.totalCount),
    usedCount: countValue(book.usedCount),
    remainingCount: countValue(book.remainingCount),
    createTime: book.createTime || 0
  }
}

/* ================= 状态与账本列表 ================= */

function stateFor(openid, bookId) {
  const user = getUser(openid)
  if (!user) return null

  const book = bookId ? getBook(bookId) : null
  const access = book ? getAccess(book, openid) : null

  if (!book || !access) {
    return {
      user: { userId: openid, name: user.name || '微信用户', avatarUrl: user.avatarUrl || '', platformAdmin: isPlatform(openid) },
      book: null,
      role: 'none',
      permissions: { manage: false, consume: false },
      members: [],
      bills: [],
      notifications: []
    }
  }

  const members = store.find('members', (item) => item.bookId === book._id)
    .map((item) => toMember(item, openid, { showInvite: access.canManage }))
    .sort((left, right) => {
      if (left.bound !== right.bound) return left.bound ? -1 : 1
      return (right.createTime || 0) - (left.createTime || 0)
    })

  const bills = store.find('bills', (item) => item.bookId === book._id)
    .map(toBill)
    .sort((left, right) => (right.time || 0) - (left.time || 0))

  const notifications = access.canManage
    ? store.find('notifications', (item) => item.bookId === book._id && item.recipientOpenid === openid)
      .map(toNotification)
      .sort((left, right) => (right.time || 0) - (left.time || 0))
    : []

  return {
    user: { userId: openid, name: user.name || '微信用户', avatarUrl: user.avatarUrl || '', platformAdmin: isPlatform(openid) },
    book: toBook(book),
    role: access.role,
    permissions: { manage: access.canManage, consume: access.canConsume },
    members,
    bills,
    notifications
  }
}

function myBooks(openid) {
  if (isPlatform(openid)) {
    return store.all('books')
      .map((book) => ({ ...toBook(book), role: 'platform' }))
      .sort((left, right) => (right.createTime || 0) - (left.createTime || 0))
  }

  const owned = store.find('books', (item) => item.ownerOpenid === openid)
  const boundRows = store.find('members', (item) => item.userOpenid === openid)
  const rowsByBook = {}
  boundRows.forEach((row) => {
    if (!rowsByBook[row.bookId]) rowsByBook[row.bookId] = row
  })
  const boundBooks = store.find('books', (item) => Object.prototype.hasOwnProperty.call(rowsByBook, item._id))

  const merged = {}
  owned.concat(boundBooks).forEach((book) => {
    const row = rowsByBook[book._id]
    const isOwner = book.ownerOpenid === openid
    let role = isOwner ? 'owner' : 'member'
    if (!isOwner && row && row.permissions && row.permissions.manage) role = 'manager'
    merged[book._id] = {
      ...toBook(book),
      role,
      boundName: row ? row.name || '' : ''
    }
  })

  return Object.keys(merged)
    .map((id) => merged[id])
    .sort((left, right) => (right.createTime || 0) - (left.createTime || 0))
}

/* ================= 鉴权 ================= */

function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.indexOf('Bearer ') === 0 ? header.slice(7) : ''
  const session = store.one('sessions', (item) => item.token === token && item.expiresAt > now())
  if (!session) {
    res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: '登录已过期' })
    return
  }
  req.openid = session.openid
  next()
}

function requireAccess(book, openid, canManageOnly = false) {
  const access = getAccess(book, openid)
  if (!access) return { error: '暂无该账本访问权限' }
  if (canManageOnly && !access.canManage) return { error: '仅账本创建者或授权管理员可以操作' }
  return { access }
}

/* ================= 登录 / 状态 ================= */

app.get('/health', (req, res) => {
  res.json({ ok: true })
})

app.post('/login', async (req, res, next) => {
  try {
    const body = req.body || {}
    let openid = ''
    try {
      const session = await wechat.code2Session(body.code)
      openid = session.openid
    } catch (error) {
      res.json({ ok: false, message: error.message || '微信登录失败' })
      return
    }

    const profile = body.profile || {}
    let user = getUser(openid)
    let isNewUser = false

    if (!user) {
      const first = store.all('users').length === 0
      user = {
        _id: makeId('user'),
        openid,
        name: cleanText(profile.name, '微信用户'),
        avatarUrl: cleanText(profile.avatarUrl),
        platformAdmin: first || ADMIN_OPENIDS.indexOf(openid) !== -1,
        createTime: now(),
        updateTime: now()
      }
      store.insert('users', user)
      isNewUser = true

      const snapshot = body.localSnapshot
      if (user.platformAdmin && snapshot && (snapshot.hasData || (snapshot.members || []).length ||
        (snapshot.bills || []).length || (snapshot.notifications || []).length)) {
        const localBook = snapshot.book || {}
        const book = {
          _id: cleanText(localBook.id, makeId('book')),
          name: cleanText(localBook.name, '我的拼单账本'),
          ownerOpenid: openid,
          totalCount: countValue(localBook.totalCount),
          usedCount: countValue(localBook.usedCount),
          remainingCount: countValue(localBook.remainingCount),
          createTime: countValue(localBook.createTime, now()),
          updateTime: now()
        }
        store.insert('books', book)
        ;(snapshot.members || []).slice(0, 200).forEach((item) => {
          store.insert('members', {
            _id: cleanText(item.id, makeId('member')),
            bookId: book._id,
            name: cleanText(item.name, '未命名成员'),
            totalCount: countValue(item.totalCount),
            usedCount: countValue(item.usedCount),
            remainingCount: countValue(item.remainingCount, countValue(item.totalCount)),
            userOpenid: '',
            inviteCode: cleanText(item.inviteCode, String(Math.floor(100000 + Math.random() * 900000))),
            permissions: { consume: false, manage: false },
            createTime: countValue(item.createTime, now()),
            updateTime: now()
          })
        })
        ;(snapshot.bills || []).slice(0, 200).forEach((item) => {
          store.insert('bills', {
            _id: cleanText(item.id, makeId('bill')),
            bookId: book._id,
            type: item.type || 'consume',
            memberId: item.memberId || '',
            memberName: item.memberName || '',
            count: countValue(item.count),
            amountText: item.amountText || '',
            title: item.title || '',
            remark: item.remark || '',
            operatorOpenid: openid,
            timeText: item.timeText || formatTime(item.time || now()),
            time: countValue(item.time, now())
          })
        })
      }
    } else {
      const updates = { updateTime: now() }
      if (cleanText(profile.name)) updates.name = cleanText(profile.name, '微信用户')
      if (profile.avatarUrl) updates.avatarUrl = cleanText(profile.avatarUrl)
      if (Object.keys(updates).length > 1) store.updateOne('users', (item) => item.openid === openid, updates)
    }

    const token = wechat.randomToken()
    store.insert('sessions', {
      _id: makeId('session'),
      token,
      openid,
      createTime: now(),
      expiresAt: now() + 30 * 24 * 60 * 60 * 1000
    })

    const books = myBooks(openid)
    const defaultBookId = cleanText(body.bookId) || (books.length ? books[0].id : '')
    const state = stateFor(openid, defaultBookId)
    state.myBooks = books

    res.json({ ok: true, token, isNewUser, state })
  } catch (error) {
    next(error)
  }
})

app.get('/state', requireAuth, (req, res) => {
  const state = stateFor(req.openid, cleanText(req.query.bookId))
  if (!state) {
    res.status(404).json({ ok: false, message: '账号不存在' })
    return
  }
  state.myBooks = myBooks(req.openid)
  res.json({ ok: true, state })
})

app.get('/books', requireAuth, (req, res) => {
  res.json({ ok: true, myBooks: myBooks(req.openid) })
})

app.post('/books', requireAuth, (req, res) => {
  const book = {
    _id: makeId('book'),
    name: cleanText(req.body.name, '我的拼单账本'),
    ownerOpenid: req.openid,
    totalCount: 0,
    usedCount: 0,
    remainingCount: 0,
    createTime: now(),
    updateTime: now()
  }
  store.insert('books', book)
  const state = stateFor(req.openid, book._id)
  state.myBooks = myBooks(req.openid)
  res.json({ ok: true, bookId: book._id, state })
})

app.post('/profile', requireAuth, (req, res) => {
  const updates = { updateTime: now() }
  if (typeof req.body.name === 'string') updates.name = cleanText(req.body.name, '微信用户')
  if (typeof req.body.avatarUrl === 'string') updates.avatarUrl = cleanText(req.body.avatarUrl)
  store.updateOne('users', (item) => item.openid === req.openid, updates)
  const state = stateFor(req.openid, cleanText(req.body.bookId))
  state.myBooks = myBooks(req.openid)
  res.json({ ok: true, state })
})

app.post('/avatar', requireAuth, (req, res) => {
  const data = String(req.body.data || '')
  if (!data) {
    res.status(400).json({ ok: false, message: '缺少图片数据' })
    return
  }
  const ext = /^[a-z0-9]{1,5}$/i.test(String(req.body.ext || '')) ? req.body.ext.toLowerCase() : 'png'
  const name = `avatar_${req.openid.replace(/[^a-zA-Z0-9_-]/g, '')}_${Date.now()}.${ext}`
  try {
    fs.writeFileSync(path.join(OBJECT_DIR, name), Buffer.from(data, 'base64'))
  } catch (error) {
    res.json({ ok: false, message: '头像保存失败' })
    return
  }
  res.json({ ok: true, url: `${PUBLIC_BASE_URL}/files/${name}` })
})
/* ================= 加入账本 ================= */

app.post('/bind', requireAuth, (req, res) => {
  const inviteCode = cleanText(req.body.inviteCode)
  if (!inviteCode) {
    res.json({ ok: false, message: '请输入邀请码' })
    return
  }

  const member = store.one('members', (item) => item.inviteCode === inviteCode)
  if (!member) {
    res.json({ ok: false, message: '邀请码无效，请联系账本创建者' })
    return
  }
  if (member.userOpenid && member.userOpenid !== req.openid) {
    res.json({ ok: false, message: '该成员已绑定其他微信账号' })
    return
  }

  const book = getBook(member.bookId)
  if (!book) {
    res.json({ ok: false, message: '账本不存在' })
    return
  }

  const access = getAccess(book, req.openid)
  if (access && (access.role === 'owner' || access.role === 'platform')) {
    res.json({ ok: false, message: '您是账本创建者或后台管理员，无需绑定成员' })
    return
  }
  if (access && access.member && access.member._id !== member._id) {
    res.json({ ok: false, message: '您已在该账本绑定其他成员' })
    return
  }

  member.userOpenid = req.openid
  member.bindTime = now()
  member.updateTime = now()
  store.persist(['members'])

  const state = stateFor(req.openid, book._id)
  state.myBooks = myBooks(req.openid)
  res.json({ ok: true, bookId: book._id, state })
})

/* ================= 成员 / 次数 ================= */

function addMemberRoute(req, res) {
  const book = getBook(req.params.bookId)
  const checked = requireAccess(book, req.openid, true)
  if (!book || checked.error) {
    res.status(403).json({ ok: false, message: checked.error || '账本不存在' })
    return
  }

  const count = Math.max(0, countValue(req.body.count))
  const member = {
    _id: makeId('member'),
    bookId: book._id,
    name: cleanText(req.body.name, '未命名成员'),
    totalCount: count,
    usedCount: 0,
    remainingCount: count,
    userOpenid: '',
    inviteCode: String(Math.floor(100000 + Math.random() * 900000)),
    permissions: { consume: false, manage: false },
    createTime: now(),
    updateTime: now()
  }

  const books = store.raw('books')
  const members = store.raw('members')
  const bills = store.raw('bills')
  members.push(member)

  if (count > 0) {
    const timestamp = now()
    book.totalCount += count
    book.remainingCount += count
    book.updateTime = timestamp
    bills.push({
      _id: makeId('bill'),
      bookId: book._id,
      type: 'recharge',
      memberId: member._id,
      memberName: member.name,
      count,
      amountText: `+${count} 次`,
      title: `初始分配 · ${member.name}`,
      remark: '',
      operatorOpenid: req.openid,
      timeText: formatTime(timestamp),
      time: timestamp
    })
  }
  store.persist(['books', 'members', 'bills'])

  const state = stateFor(req.openid, book._id)
  state.myBooks = myBooks(req.openid)
  res.json({ ok: true, state, member: toMember(member, req.openid, { showInvite: true }) })
}

function permissionRoute(req, res) {
  const book = getBook(req.params.bookId)
  const member = store.one('members', (item) => item._id === req.params.memberId && item.bookId === (book && book._id))
  if (!book || !member) {
    res.status(404).json({ ok: false, message: '成员不存在' })
    return
  }
  const checked = requireAccess(book, req.openid)
  if (checked.error || !checked.access.canGrant) {
    res.status(403).json({ ok: false, message: '仅账本创建者或后台管理员可以授予权限' })
    return
  }

  const manage = boolValue(req.body.manage)
  const consume = boolValue(req.body.consume) || manage
  member.permissions = { consume, manage }
  member.updateTime = now()
  store.persist(['members'])

  const state = stateFor(req.openid, book._id)
  state.myBooks = myBooks(req.openid)
  res.json({ ok: true, state })
}

function addCountRoute(req, res) {
  const book = getBook(req.params.bookId)
  const member = store.one('members', (item) => item._id === req.params.memberId && item.bookId === (book && book._id))
  const checked = requireAccess(book, req.openid, true)
  if (!book || !member || checked.error) {
    res.status(403).json({ ok: false, message: checked.error || '成员不存在' })
    return
  }

  const count = Math.max(1, countValue(req.body.count, 1))
  const timestamp = now()
  book.totalCount += count
  book.remainingCount += count
  book.updateTime = timestamp
  member.totalCount += count
  member.remainingCount += count
  member.updateTime = timestamp

  store.raw('bills').push({
    _id: makeId('bill'),
    bookId: book._id,
    type: 'allocate',
    memberId: member._id,
    memberName: member.name,
    count,
    amountText: `+${count} 次`,
    title: `二次分配 · ${member.name}`,
    remark: '',
    operatorOpenid: req.openid,
    timeText: formatTime(timestamp),
    time: timestamp
  })
  store.persist(['books', 'members', 'bills'])

  const state = stateFor(req.openid, book._id)
  state.myBooks = myBooks(req.openid)
  res.json({ ok: true, state, operation: { count, memberId: member._id } })
}

function consumeRoute(req, res) {
  const book = getBook(req.params.bookId)
  const member = store.one('members', (item) => item._id === req.params.memberId && item.bookId === (book && book._id))
  const checked = requireAccess(book, req.openid)
  if (!book || !member || checked.error) {
    res.status(403).json({ ok: false, message: checked.error || '成员不存在' })
    return
  }

  if (!checked.access.canManage) {
    if (!checked.access.canConsume || member.userOpenid !== req.openid) {
      res.status(403).json({ ok: false, message: '您仅可查看账本，需账本创建者授予核销权限' })
      return
    }
  }

  const requested = Math.max(1, countValue(req.body.count, 1))
  const consumed = Math.min(requested, countValue(book.remainingCount), countValue(member.remainingCount))
  if (consumed <= 0) {
    res.json({ ok: false, message: `「${member.name}」暂无剩余次数` })
    return
  }

  const timestamp = now()
  book.usedCount += consumed
  book.remainingCount -= consumed
  book.updateTime = timestamp
  member.usedCount += consumed
  member.remainingCount -= consumed
  member.updateTime = timestamp

  store.raw('bills').push({
    _id: makeId('bill'),
    bookId: book._id,
    type: 'consume',
    memberId: member._id,
    memberName: member.name,
    count: consumed,
    amountText: `-${consumed} 次`,
    title: `核销 · ${member.name}`,
    remark: cleanText(req.body.remark),
    operatorOpenid: req.openid,
    timeText: formatTime(timestamp),
    time: timestamp
  })

  const notifyOpenids = []
  if (!checked.access.canManage) {
    if (book.ownerOpenid) notifyOpenids.push(book.ownerOpenid)
    store.find('members', (item) => item.bookId === book._id && item.permissions && item.permissions.manage)
      .forEach((item) => {
        if (item.userOpenid && notifyOpenids.indexOf(item.userOpenid) === -1) notifyOpenids.push(item.userOpenid)
      })
  }

  const noticeIds = []
  let ownerNoticeId = null
  if (notifyOpenids.length) {
    const notifications = store.raw('notifications')
    notifyOpenids.forEach((recipientOpenid) => {
      const noticeId = makeId('notice')
      noticeIds.push(noticeId)
      if (recipientOpenid === book.ownerOpenid) ownerNoticeId = noticeId
      notifications.push({
        _id: noticeId,
        bookId: book._id,
        recipientOpenid,
        type: 'consume',
        memberId: member._id,
        memberName: member.name,
        count: consumed,
        remark: cleanText(req.body.remark),
        timeText: formatTime(timestamp),
        time: timestamp,
        read: false
      })
    })
  }
  store.persist(['books', 'members', 'bills', 'notifications'])

  const state = stateFor(req.openid, book._id)
  state.myBooks = myBooks(req.openid)
  res.json({ ok: true, state, operation: { count: consumed, memberId: member._id } })

  // 异步写推送结果，不影响核销响应
  if (!checked.access.canManage && notifyOpenids.length) {
    wechat.sendSubscribe({
      openid: book.ownerOpenid,
      templateId: SUBSCRIBE_TEMPLATE_ID,
      page: 'pages/mine/index',
      data: {
        thing1: { value: `成员${cleanText(member.name, '成员')}核销${consumed}次` },
        time2: { value: formatTime(timestamp) }
      }
    }).then((sendResult) => {
      if (ownerNoticeId) {
        store.updateOne('notifications', (item) => item._id === ownerNoticeId, {
          subscribe: { ok: !!sendResult.ok, message: sendResult.message || '' }
        })
      }
    }).catch(() => {})
  }
}

function removeMemberRoute(req, res) {
  const book = getBook(req.params.bookId)
  const member = store.one('members', (item) => item._id === req.params.memberId && item.bookId === (book && book._id))
  const checked = requireAccess(book, req.openid)
  if (!book || !member || checked.error || !checked.access.canGrant) {
    res.status(403).json({ ok: false, message: '仅账本创建者或后台管理员可以删除成员' })
    return
  }

  const remaining = countValue(member.remainingCount)
  store.removeOne('members', (item) => item._id === member._id)
  if (remaining > 0) {
    const timestamp = now()
    book.remainingCount += remaining
    book.updateTime = timestamp
    store.raw('bills').push({
      _id: makeId('bill'),
      bookId: book._id,
      type: 'refund',
      memberId: member._id,
      memberName: member.name,
      count: remaining,
      amountText: `+${remaining} 次`,
      title: `删除成员退回 · ${member.name}`,
      remark: '',
      operatorOpenid: req.openid,
      timeText: formatTime(timestamp),
      time: timestamp
    })
  }
  store.persist(['books', 'members', 'bills'])

  const state = stateFor(req.openid, book._id)
  state.myBooks = myBooks(req.openid)
  res.json({ ok: true, state, member: toMember(member, req.openid, { showInvite: true }) })
}

app.post('/books/:bookId/members', requireAuth, addMemberRoute)
app.patch('/books/:bookId/members/:memberId/permissions', requireAuth, permissionRoute)
app.post('/books/:bookId/members/:memberId/count', requireAuth, addCountRoute)
app.post('/books/:bookId/members/:memberId/consume', requireAuth, consumeRoute)
app.delete('/books/:bookId/members/:memberId', requireAuth, removeMemberRoute)

/* ================= 通知 ================= */

app.post('/books/:bookId/notifications/read', requireAuth, (req, res) => {
  const book = getBook(req.params.bookId)
  const checked = requireAccess(book, req.openid, true)
  if (!book || checked.error) {
    res.status(403).json({ ok: false, message: checked.error || '账本不存在' })
    return
  }
  store.updateMany('notifications', (item) => item.bookId === book._id &&
    item.recipientOpenid === req.openid && !item.read, { read: true })
  const state = stateFor(req.openid, book._id)
  state.myBooks = myBooks(req.openid)
  res.json({ ok: true, state })
})

app.delete('/books/:bookId/notifications', requireAuth, (req, res) => {
  const book = getBook(req.params.bookId)
  const checked = requireAccess(book, req.openid, true)
  if (!book || checked.error) {
    res.status(403).json({ ok: false, message: checked.error || '账本不存在' })
    return
  }
  store.removeMany('notifications', (item) => item.bookId === book._id && item.recipientOpenid === req.openid)
  const state = stateFor(req.openid, book._id)
  state.myBooks = myBooks(req.openid)
  res.json({ ok: true, state })
})

app.delete('/books/:bookId/reset', requireAuth, (req, res) => {
  const book = getBook(req.params.bookId)
  const checked = requireAccess(book, req.openid)
  if (!book || checked.error || !checked.access.canGrant) {
    res.status(403).json({ ok: false, message: '仅账本创建者或后台管理员可以清空账本' })
    return
  }
  store.removeMany('members', (item) => item.bookId === book._id)
  store.removeMany('bills', (item) => item.bookId === book._id)
  store.removeMany('notifications', (item) => item.bookId === book._id)
  book.totalCount = 0
  book.usedCount = 0
  book.remainingCount = 0
  book.updateTime = now()
  store.persist(['books'])
  const state = stateFor(req.openid, book._id)
  state.myBooks = myBooks(req.openid)
  res.json({ ok: true, state })
})

/* ================= 邀请小程序码 ================= */

app.get('/invite-qr', requireAuth, async (req, res, next) => {
  try {
    const book = getBook(req.query.bookId)
    const member = store.one('members', (item) => item._id === req.query.memberId && item.bookId === (book && book._id))
    const checked = requireAccess(book, req.openid, true)
    if (!book || !member || checked.error) {
      res.status(403).json({ ok: false, message: checked.error || '成员不存在' })
      return
    }

    const envVersion = ['develop', 'trial', 'release'].indexOf(req.query.envVersion) !== -1
      ? req.query.envVersion
      : 'release'
    try {
      const qrBase64 = await wechat.wxacode({
        scene: `c${member.inviteCode}`,
        page: 'pages/member/index',
        envVersion
      })
      res.json({ ok: true, qrBase64, inviteCode: member.inviteCode })
    } catch (error) {
      res.json({ ok: true, qrBase64: '', inviteCode: member.inviteCode, qrError: '小程序码生成失败，请改用邀请码分享' })
    }
  } catch (error) {
    next(error)
  }
})

/* ================= 启动 ================= */

app.use((req, res) => {
  res.status(404).json({ ok: false, message: '接口不存在' })
})

app.use((error, req, res, next) => {
  console.error('API 错误：', error)
  res.status(500).json({ ok: false, message: error.message || '服务内部错误' })
})

app.listen(PORT, () => {
  console.log(`拼单账本 API listening on http://0.0.0.0:${PORT}`)
})