/**
 * 拼单账本 - 云函数统一入口
 *
 * 权限模型：
 * - platformAdmin（后台管理员）：第一个注册账号或 ADMIN_OPENIDS 中配置的账号，可管理全部账本。
 * - owner（账本创建者）：在「我的」页创建账本后成为该账本管理员，拥有成员管理权限。
 * - manager：账本创建者/后台管理员在成员上开启「管理」权限的绑定成员，可协助分配与核销。
 * - member：绑定邀请码加入账本的成员，默认仅查看成员与次数；被授予「核销」权限后可核销自己。
 *
 * 集合：
 * - users：微信账号与后台管理员标记
 * - books：账本、创建者、总次数
 * - members：成员行、邀请码、绑定微信、权限
 * - bills：分配、核销、退回流水
 * - notifications：给账本创建者/管理员的核销通知
 *
 * 所有写操作都从 wx-server-sdk 获取 OPENID，不信任客户端传入的角色。
 */

const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command
let OPENID = ''
const DEFAULT_SUBSCRIBE_TEMPLATE_ID = 'CAlj2-_f5pFaXLaNIP_3JRnWq5cDPrc1XNUui1ebDPk'
const SUBSCRIBE_TEMPLATE_ID = process.env.SUBSCRIBE_TEMPLATE_ID || DEFAULT_SUBSCRIBE_TEMPLATE_ID
const ADMIN_OPENIDS = (process.env.ADMIN_OPENIDS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)

const COLLECTIONS = {
  users: 'users',
  books: 'books',
  members: 'members',
  bills: 'bills',
  notifications: 'notifications'
}

const COLLECTION_NAMES = Object.keys(COLLECTIONS).map((key) => COLLECTIONS[key])

async function ensureCollections() {
  for (const name of COLLECTION_NAMES) {
    try {
      await db.createCollection(name)
    } catch (error) {
      // 集合已存在时跳过；并发创建时也允许忽略。
    }
  }
}

const now = () => Date.now()

const makeId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

const countValue = (value, fallback = 0) => {
  const number = parseInt(value, 10)
  return Number.isFinite(number) ? number : fallback
}

const cleanText = (value, fallback = '') => String(value || '').trim() || fallback

const boolValue = (value) => value === true || value === 'true' || value === 1

const formatTime = (timestamp) => {
  const date = new Date(timestamp)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function getUser() {
  if (!OPENID) return null

  const result = await db.collection(COLLECTIONS.users)
    .where({ openid: OPENID })
    .limit(1)
    .get()

  return result.data[0] || null
}

async function getBook(bookId) {
  if (!bookId) return null

  try {
    const result = await db.collection(COLLECTIONS.books).doc(bookId).get()
    return result.data || null
  } catch (error) {
    return null
  }
}

async function requireUser() {
  const user = await getUser()
  if (!user) throw new Error('账号未注册，请先在「我的」页微信登录')
  return user
}

const isPlatform = (user) => !!(user && (user.platformAdmin || ADMIN_OPENIDS.indexOf(OPENID) !== -1))

async function getMemberRowByCode(code) {
  if (!cleanText(code)) return null

  const result = await db.collection(COLLECTIONS.members)
    .where({ inviteCode: cleanText(code) })
    .limit(1)
    .get()

  return result.data[0] || null
}

async function getMemberInBook(bookId, memberId) {
  if (!bookId || !memberId) return null

  try {
    const result = await db.collection(COLLECTIONS.members).doc(memberId).get()
    const member = result.data
    return member && member.bookId === bookId ? member : null
  } catch (error) {
    return null
  }
}

// 返回当前用户在账本中的访问级别
async function getAccess(user, book) {
  if (!user || !book) return null

  if (book.ownerOpenid === OPENID) {
    return { role: 'owner', canManage: true, canConsume: true, canGrant: true, member: null }
  }

  if (isPlatform(user)) {
    return { role: 'platform', canManage: true, canConsume: true, canGrant: true, member: null }
  }

  const result = await db.collection(COLLECTIONS.members)
    .where({ bookId: book._id, userOpenid: OPENID })
    .limit(1)
    .get()

  const member = result.data[0]
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

function toMemberView(member, options = {}) {
  const permissions = (member && member.permissions) || {}

  return {
    id: member._id,
    name: member.name || '未命名成员',
    totalCount: countValue(member.totalCount),
    usedCount: countValue(member.usedCount),
    remainingCount: countValue(member.remainingCount),
    userId: member.userOpenid || '',
    bound: !!member.userOpenid,
    isMe: !!member.userOpenid && member.userOpenid === OPENID,
    inviteCode: options.showInvite ? member.inviteCode || '' : '',
    permissions: {
      consume: !!permissions.consume,
      manage: !!permissions.manage
    },
    createTime: member.createTime || 0
  }
}

function toBill(bill) {
  if (!bill) return null

  return {
    id: bill._id || bill.id || '',
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

function toNotification(notification) {
  if (!notification) return null

  return {
    id: notification._id || notification.id || '',
    type: notification.type || 'consume',
    memberId: notification.memberId || '',
    memberName: notification.memberName || '',
    count: countValue(notification.count),
    remark: notification.remark || '',
    timeText: notification.timeText || formatTime(notification.time || 0),
    time: notification.time || 0,
    read: !!notification.read,
    subscribe: notification.subscribe || null
  }
}function toBookView(book) {
  if (!book) return null

  return {
    id: book._id || book.id || '',
    name: book.name || '未命名账本',
    ownerOpenid: book.ownerOpenid || book.adminOpenid || '',
    totalCount: countValue(book.totalCount),
    usedCount: countValue(book.usedCount),
    remainingCount: countValue(book.remainingCount),
    createTime: book.createTime || 0
  }
}

function emptyState(user) {
  return {
    user: {
      userId: OPENID,
      name: (user && user.name) || '微信用户',
      avatarUrl: (user && user.avatarUrl) || '',
      platformAdmin: isPlatform(user)
    },
    book: null,
    role: 'none',
    permissions: { manage: false, consume: false },
    members: [],
    bills: [],
    notifications: [],
    myBooks: []
  }
}

async function stateFor(user, book, access) {
  if (!book || !access) return emptyState(user)

  const memberQuery = db.collection(COLLECTIONS.members)
    .where({ bookId: book._id })
    .limit(200)
    .get()

  const billQuery = db.collection(COLLECTIONS.bills)
    .where({ bookId: book._id })
    .limit(200)
    .get()

  const notificationQuery = access.canManage
    ? db.collection(COLLECTIONS.notifications)
      .where({
        bookId: book._id,
        recipientOpenid: OPENID
      })
      .limit(100)
      .get()
    : Promise.resolve({ data: [] })

  const results = await Promise.all([memberQuery, billQuery, notificationQuery])

  const members = results[0].data
    .map((member) => toMemberView(member, { showInvite: access.canManage }))
    .sort((left, right) => {
      const leftBound = left.bound ? 1 : 0
      const rightBound = right.bound ? 1 : 0
      if (leftBound !== rightBound) return rightBound - leftBound
      return (right.createTime || 0) - (left.createTime || 0)
    })

  const bills = results[1].data
    .map(toBill)
    .filter(Boolean)
    .sort((left, right) => (right.time || 0) - (left.time || 0))

  const notifications = results[2].data
    .map(toNotification)
    .filter(Boolean)
    .sort((left, right) => (right.time || 0) - (left.time || 0))

  return {
    user: {
      userId: OPENID,
      name: (user && user.name) || '微信用户',
      avatarUrl: (user && user.avatarUrl) || '',
      platformAdmin: isPlatform(user)
    },
    book: toBookView(book),
    role: access.role,
    permissions: {
      manage: access.canManage,
      consume: access.canConsume
    },
    members,
    bills,
    notifications
  }
}

async function myBooks(user) {
  const userIsPlatform = isPlatform(user)

  let owned = []
  let boundBooks = []

  if (userIsPlatform) {
    const all = await db.collection(COLLECTIONS.books)
      .limit(200)
      .get()
    owned = all.data
  } else {
    const ownedResult = await db.collection(COLLECTIONS.books)
      .where({ ownerOpenid: OPENID })
      .limit(200)
      .get()
    owned = ownedResult.data

    const boundResult = await db.collection(COLLECTIONS.members)
      .where({ userOpenid: OPENID })
      .limit(200)
      .get()
    const boundRows = boundResult.data
    const bookIds = boundRows
      .map((row) => row.bookId)
      .filter((bookId, index, list) => bookId && list.indexOf(bookId) === index)

    if (bookIds.length) {
      const booksResult = await db.collection(COLLECTIONS.books)
        .where({ _id: _.in(bookIds) })
        .limit(200)
        .get()
      boundBooks = booksResult.data
    }
  }

  const ownedIds = owned.map((book) => book._id)
  const rowsById = {}
  if (!userIsPlatform) {
    const boundResult = await db.collection(COLLECTIONS.members)
      .where({ userOpenid: OPENID })
      .limit(200)
      .get()
    boundResult.data.forEach((row) => {
      rowsById[row.bookId] = row
    })
  }

  const merged = {}
  owned.concat(boundBooks).forEach((book) => {
    if (!book) return
    const id = book._id
    const isOwner = ownedIds.indexOf(id) !== -1
    const boundRow = rowsById[id]
    let role = 'owner'
    if (!isOwner) {
      role = boundRow && boundRow.permissions && boundRow.permissions.manage ? 'manager' : 'member'
    }
    if (userIsPlatform) role = 'platform'
    merged[id] = {
      id,
      name: book.name || '未命名账本',
      totalCount: countValue(book.totalCount),
      usedCount: countValue(book.usedCount),
      remainingCount: countValue(book.remainingCount),
      role,
      boundName: boundRow ? boundRow.name || '' : '',
      createTime: book.createTime || 0
    }
  })

  return Object.keys(merged)
    .map((id) => merged[id])
    .sort((left, right) => (right.createTime || 0) - (left.createTime || 0))
}

async function stateResult(user, book, access) {
  const state = await stateFor(user, book, access)
  state.myBooks = await myBooks(user)
  return {
    ok: true,
    state
  }
}

function hasLocalData(snapshot) {
  return !!(snapshot && (
    snapshot.hasData ||
    (snapshot.members && snapshot.members.length) ||
    (snapshot.bills && snapshot.bills.length) ||
    (snapshot.notifications && snapshot.notifications.length)
  ))
}

async function migrateLocalData(book, snapshot) {
  if (!hasLocalData(snapshot)) return

  const localMembers = Array.isArray(snapshot.members) ? snapshot.members : []
  const localBills = Array.isArray(snapshot.bills) ? snapshot.bills : []
  const localNotifications = Array.isArray(snapshot.notifications) ? snapshot.notifications : []

  for (const item of localMembers) {
    const memberId = cleanText(item.id, makeId('member'))
    const totalCount = countValue(item.totalCount)
    await db.collection(COLLECTIONS.members).add({
      data: {
        _id: memberId,
        bookId: book._id,
        name: cleanText(item.name, '未命名成员'),
        totalCount,
        usedCount: countValue(item.usedCount),
        remainingCount: countValue(item.remainingCount, totalCount),
        userOpenid: '',
        inviteCode: cleanText(item.inviteCode, String(Math.floor(100000 + Math.random() * 900000))),
        permissions: { consume: false, manage: false },
        createTime: countValue(item.createTime, now()),
        updateTime: now()
      }
    })
  }

  for (const item of localBills.slice(0, 200)) {
    await db.collection(COLLECTIONS.bills).add({
      data: {
        _id: cleanText(item.id, makeId('bill')),
        bookId: book._id,
        type: item.type || 'consume',
        memberId: item.memberId || '',
        memberName: item.memberName || '',
        count: countValue(item.count),
        amountText: item.amountText || '',
        title: item.title || '',
        remark: item.remark || '',
        operatorOpenid: book.ownerOpenid,
        timeText: item.timeText || formatTime(item.time || now()),
        time: countValue(item.time, now())
      }
    })
  }

  for (const item of localNotifications.slice(0, 100)) {
    await db.collection(COLLECTIONS.notifications).add({
      data: {
        _id: cleanText(item.id, makeId('notice')),
        bookId: book._id,
        recipientOpenid: book.ownerOpenid,
        type: item.type || 'consume',
        memberId: item.memberId || '',
        memberName: item.memberName || '',
        count: countValue(item.count),
        remark: item.remark || '',
        timeText: item.timeText || formatTime(item.time || now()),
        time: countValue(item.time, now()),
        read: !!item.read
      }
    })
  }
}

async function pickDefaultBook(user) {
  const list = await myBooks(user)
  if (list.length) return list[0].id
  return ''
}

async function login(data) {
  await ensureCollections()
  if (!OPENID) throw new Error('未获取到微信用户身份')

  const profile = (data && data.profile) || {}
  let user = await getUser()
  let isNewUser = false

  if (user) {
    // 兼容旧版本：旧管理员账号升级为后台管理员，旧账本补上创建者。
    if (user.role === 'admin' && user.bookId) {
      const legacyBook = await getBook(user.bookId)
      if (legacyBook && !legacyBook.ownerOpenid) {
        await db.collection(COLLECTIONS.books).doc(legacyBook._id).update({
          data: { ownerOpenid: OPENID, updateTime: now() }
        })
      }
      await db.collection(COLLECTIONS.users).doc(user._id).update({
        data: { platformAdmin: true, updateTime: now() }
      })
      user = await getUser()
    }

    const updates = {}
    if (cleanText(profile.name)) updates.name = cleanText(profile.name, '微信用户')
    if (profile.avatarUrl) updates.avatarUrl = cleanText(profile.avatarUrl)
    if (Object.keys(updates).length) {
      updates.updateTime = now()
      await db.collection(COLLECTIONS.users).doc(user._id).update({ data: updates })
      user = await getUser()
    }
  } else {
    const existing = await db.collection(COLLECTIONS.users).limit(1).get()
    const isFirstUser = existing.data.length === 0
    const platformAdmin = isFirstUser || ADMIN_OPENIDS.indexOf(OPENID) !== -1

    user = {
      _id: makeId('user'),
      openid: OPENID,
      name: cleanText(profile.name, '微信用户'),
      avatarUrl: cleanText(profile.avatarUrl),
      platformAdmin,
      createTime: now(),
      updateTime: now()
    }
    await db.collection(COLLECTIONS.users).add({ data: user })
    isNewUser = true

    // 首次注册且带本地旧账本快照时，把本地数据迁移到用户自己的账本。
    const snapshot = data && data.localSnapshot
    if (platformAdmin && hasLocalData(snapshot)) {
      const localBook = snapshot.book || {}
      const book = {
        _id: cleanText(localBook.id, makeId('book')),
        name: cleanText(localBook.name, '我的拼单账本'),
        ownerOpenid: OPENID,
        totalCount: countValue(localBook.totalCount),
        usedCount: countValue(localBook.usedCount),
        remainingCount: countValue(localBook.remainingCount),
        createTime: countValue(localBook.createTime, now()),
        updateTime: now()
      }
      await db.collection(COLLECTIONS.books).add({ data: book })
      await migrateLocalData(book, snapshot)
    }
  }

  const bookId = cleanText(data && data.bookId) || await pickDefaultBook(user)
  const book = await getBook(bookId)
  const access = book ? await getAccess(user, book) : null
  const result = await stateResult(user, book, access)
  result.isNewUser = isNewUser
  return result
}

async function updateProfile(data) {
  const user = await requireUser()

  const updates = { updateTime: now() }
  if (typeof (data && data.name) === 'string') updates.name = cleanText(data.name, '微信用户')
  if (typeof (data && data.avatarUrl) === 'string') updates.avatarUrl = cleanText(data.avatarUrl)

  await db.collection(COLLECTIONS.users).doc(user._id).update({ data: updates })
  const updatedUser = await getUser()

  const bookId = cleanText(data && data.bookId) || await pickDefaultBook(updatedUser)
  const book = await getBook(bookId)
  const access = book ? await getAccess(updatedUser, book) : null
  return stateResult(updatedUser, book, access)
}

async function createBook(data) {
  const user = await requireUser()

  const book = {
    _id: makeId('book'),
    name: cleanText(data && data.name, '我的拼单账本'),
    ownerOpenid: OPENID,
    totalCount: 0,
    usedCount: 0,
    remainingCount: 0,
    createTime: now(),
    updateTime: now()
  }
  await db.collection(COLLECTIONS.books).add({ data: book })

  const access = await getAccess(user, book)
  const result = await stateResult(user, book, access)
  result.bookId = book._id
  return result
}

async function getState(data) {
  const user = await requireUser()
  const bookId = cleanText(data && data.bookId)
  const book = bookId ? await getBook(bookId) : null
  const access = book ? await getAccess(user, book) : null

  if (book && !access) {
    return { ok: false, message: '暂无该账本访问权限' }
  }
  return stateResult(user, book, access)
}

async function listMyBooks() {
  const user = await requireUser()
  return {
    ok: true,
    myBooks: await myBooks(user)
  }
}

async function bindMember(data) {
  const user = await requireUser()
  const inviteCode = cleanText(data && data.inviteCode)
  if (!inviteCode) throw new Error('请输入邀请码')

  const member = await getMemberRowByCode(inviteCode)
  if (!member) throw new Error('邀请码无效，请联系账本创建者')
  if (member.userOpenid && member.userOpenid !== OPENID) {
    throw new Error('该成员已绑定其他微信账号')
  }

  const book = await getBook(member.bookId)
  if (!book) throw new Error('账本不存在')

  const access = await getAccess(user, book)
  if (access && (access.role === 'owner' || access.role === 'platform')) {
    throw new Error('您是账本创建者或后台管理员，无需绑定成员')
  }
  if (access && access.member && access.member._id !== member._id) {
    throw new Error('您已在该账本绑定其他成员')
  }

  const transaction = await db.startTransaction()
  try {
    await transaction.collection(COLLECTIONS.members).doc(member._id).update({
      data: {
        userOpenid: OPENID,
        bindTime: now(),
        updateTime: now()
      }
    })
    await transaction.commit()
  } catch (error) {
    await transaction.rollback()
    throw error
  }

  const updatedBook = await getBook(book._id)
  const updatedUser = await getUser()
  const newAccess = await getAccess(updatedUser, updatedBook)
  const result = await stateResult(updatedUser, updatedBook, newAccess)
  result.bookId = updatedBook._id
  return result
}

async function addMember(data) {
  const user = await requireUser()
  const book = await getBook(data && data.bookId)
  const access = await getAccess(user, book)
  if (!book || !access || !access.canManage) throw new Error('仅账本创建者或授权管理员可以添加成员')

  const name = cleanText(data && data.name, '未命名成员')
  const count = Math.max(0, countValue(data && data.count))
  const member = {
    _id: makeId('member'),
    bookId: book._id,
    name,
    totalCount: count,
    usedCount: 0,
    remainingCount: count,
    userOpenid: '',
    inviteCode: String(Math.floor(100000 + Math.random() * 900000)),
    permissions: { consume: false, manage: false },
    createTime: now(),
    updateTime: now()
  }

  const timestamp = now()
  const transaction = await db.startTransaction()
  try {
    await transaction.collection(COLLECTIONS.members).add({ data: member })

    if (count > 0) {
      await transaction.collection(COLLECTIONS.books).doc(book._id).update({
        data: {
          totalCount: _.inc(count),
          remainingCount: _.inc(count),
          updateTime: timestamp
        }
      })
      await transaction.collection(COLLECTIONS.bills).add({
        data: {
          _id: makeId('bill'),
          bookId: book._id,
          type: 'recharge',
          memberId: member._id,
          memberName: member.name,
          count,
          amountText: `+${count} 次`,
          title: `初始分配 · ${member.name}`,
          remark: '',
          operatorOpenid: OPENID,
          timeText: formatTime(timestamp),
          time: timestamp
        }
      })
    }

    await transaction.commit()
  } catch (error) {
    await transaction.rollback()
    throw error
  }

  const result = await stateResult(user, await getBook(book._id), await getAccess(user, book))
  result.member = toMemberView(member, { showInvite: true })
  return result
}

async function grantPermission(data) {
  const user = await requireUser()
  const book = await getBook(data && data.bookId)
  const access = await getAccess(user, book)
  if (!book || !access || !access.canGrant) throw new Error('仅账本创建者或后台管理员可以授予权限')

  const member = await getMemberInBook(book._id, data && data.memberId)
  if (!member) throw new Error('成员不存在')

  const consume = boolValue(data && data.consume) || boolValue(data && data.manage)
  const manage = boolValue(data && data.manage)

  await db.collection(COLLECTIONS.members).doc(member._id).update({
    data: {
      permissions: { consume, manage },
      updateTime: now()
    }
  })

  return stateResult(user, book, access)
}

async function addCount(data) {
  const user = await requireUser()
  const book = await getBook(data && data.bookId)
  const access = await getAccess(user, book)
  if (!book || !access || !access.canManage) throw new Error('仅账本创建者或授权管理员可以分配次数')

  const count = Math.max(1, countValue(data && data.count, 1))
  const member = await getMemberInBook(book._id, data && data.memberId)
  if (!member) throw new Error('成员不存在')

  const timestamp = now()
  const transaction = await db.startTransaction()
  try {
    await transaction.collection(COLLECTIONS.books).doc(book._id).update({
      data: {
        totalCount: _.inc(count),
        remainingCount: _.inc(count),
        updateTime: timestamp
      }
    })
    await transaction.collection(COLLECTIONS.members).doc(member._id).update({
      data: {
        totalCount: _.inc(count),
        remainingCount: _.inc(count),
        updateTime: timestamp
      }
    })
    await transaction.collection(COLLECTIONS.bills).add({
      data: {
        _id: makeId('bill'),
        bookId: book._id,
        type: 'allocate',
        memberId: member._id,
        memberName: member.name,
        count,
        amountText: `+${count} 次`,
        title: `二次分配 · ${member.name}`,
        remark: '',
        operatorOpenid: OPENID,
        timeText: formatTime(timestamp),
        time: timestamp
      }
    })
    await transaction.commit()
  } catch (error) {
    await transaction.rollback()
    throw error
  }

  const result = await stateResult(user, await getBook(book._id), await getAccess(user, book))
  result.operation = { count, memberId: member._id }
  return result
}

async function getNotifyOpenids(book) {
  const openids = []
  if (book.ownerOpenid) openids.push(book.ownerOpenid)

  const result = await db.collection(COLLECTIONS.members)
    .where({ bookId: book._id, 'permissions.manage': true })
    .limit(50)
    .get()

  result.data.forEach((member) => {
    if (member.userOpenid && openids.indexOf(member.userOpenid) === -1) {
      openids.push(member.userOpenid)
    }
  })
  return openids
}

async function consumeCount(data) {
  const user = await requireUser()
  const book = await getBook(data && data.bookId)
  const access = await getAccess(user, book)
  if (!book || !access) throw new Error('请先加入或创建账本')

  const requested = Math.max(1, countValue(data && data.count, 1))
  const member = await getMemberInBook(book._id, data && data.memberId)
  if (!member) throw new Error('成员不存在')

  if (!access.canManage) {
    if (!access.canConsume || member.userOpenid !== OPENID) {
      throw new Error('您仅可查看账本，需账本创建者授予核销权限')
    }
  }

  const timestamp = now()
  const notifyOpenids = !access.canManage ? await getNotifyOpenids(book) : []
  const createdNoticeIds = []
  const transaction = await db.startTransaction()
  let consumed = 0

  try {
    const [bookResult, memberResult] = await Promise.all([
      transaction.collection(COLLECTIONS.books).doc(book._id).get(),
      transaction.collection(COLLECTIONS.members).doc(member._id).get()
    ])

    const currentBook = bookResult.data
    const currentMember = memberResult.data
    consumed = Math.min(
      requested,
      countValue(currentBook.remainingCount),
      countValue(currentMember.remainingCount)
    )

    if (consumed <= 0) {
      throw new Error(`「${currentMember.name}」暂无剩余次数`)
    }

    await transaction.collection(COLLECTIONS.books).doc(book._id).update({
      data: {
        usedCount: _.inc(consumed),
        remainingCount: _.inc(-consumed),
        updateTime: timestamp
      }
    })
    await transaction.collection(COLLECTIONS.members).doc(member._id).update({
      data: {
        usedCount: _.inc(consumed),
        remainingCount: _.inc(-consumed),
        updateTime: timestamp
      }
    })
    await transaction.collection(COLLECTIONS.bills).add({
      data: {
        _id: makeId('bill'),
        bookId: book._id,
        type: 'consume',
        memberId: member._id,
        memberName: currentMember.name,
        count: consumed,
        amountText: `-${consumed} 次`,
        title: `核销 · ${currentMember.name}`,
        remark: cleanText(data && data.remark),
        operatorOpenid: OPENID,
        timeText: formatTime(timestamp),
        time: timestamp
      }
    })

    // 成员自己核销时通知账本创建者与授权管理员。
    if (!access.canManage) {
      for (const recipientOpenid of notifyOpenids) {
        const noticeId = makeId('notice')
        createdNoticeIds.push(noticeId)
        await transaction.collection(COLLECTIONS.notifications).add({
          data: {
            _id: noticeId,
            bookId: book._id,
            recipientOpenid,
            type: 'consume',
            memberId: member._id,
            memberName: currentMember.name,
            count: consumed,
            remark: cleanText(data && data.remark),
            timeText: formatTime(timestamp),
            time: timestamp,
            read: false
          }
        })
      }
    }

    await transaction.commit()
  } catch (error) {
    await transaction.rollback()
    throw error
  }

  let subscribeResult = null
  if (!access.canManage) {
    subscribeResult = await sendSubscribeMessage({
      adminOpenid: book.ownerOpenid,
      memberName: member.name,
      count: consumed,
      timeText: formatTime(timestamp)
    })
    if (createdNoticeIds.length) {
      await Promise.all(createdNoticeIds.map((noticeId) => {
        return db.collection(COLLECTIONS.notifications).doc(noticeId).update({
          data: {
            subscribe: {
              ok: !!subscribeResult.ok,
              message: subscribeResult.message || ''
            }
          }
        })
      }))
    }
  }

  const result = await stateResult(user, await getBook(book._id), await getAccess(user, book))
  result.operation = { count: consumed, memberId: member._id }
  result.subscribe = subscribeResult
  return result
}

async function removeMember(data) {
  const user = await requireUser()
  const book = await getBook(data && data.bookId)
  const access = await getAccess(user, book)
  if (!book || !access || !access.canGrant) {
    throw new Error('仅账本创建者或后台管理员可以删除成员')
  }

  const member = await getMemberInBook(book._id, data && data.memberId)
  if (!member) throw new Error('成员不存在')

  const remaining = countValue(member.remainingCount)
  const timestamp = now()
  const transaction = await db.startTransaction()
  try {
    await transaction.collection(COLLECTIONS.members).doc(member._id).remove()

    if (remaining > 0) {
      await transaction.collection(COLLECTIONS.books).doc(book._id).update({
        data: {
          remainingCount: _.inc(remaining),
          updateTime: timestamp
        }
      })
      await transaction.collection(COLLECTIONS.bills).add({
        data: {
          _id: makeId('bill'),
          bookId: book._id,
          type: 'refund',
          memberId: member._id,
          memberName: member.name,
          count: remaining,
          amountText: `+${remaining} 次`,
          title: `删除成员退回 · ${member.name}`,
          remark: '',
          operatorOpenid: OPENID,
          timeText: formatTime(timestamp),
          time: timestamp
        }
      })
    }

    await transaction.commit()
  } catch (error) {
    await transaction.rollback()
    throw error
  }

  const result = await stateResult(user, await getBook(book._id), await getAccess(user, book))
  result.member = toMemberView(member, { showInvite: true })
  return result
}

async function markNotificationsRead(data) {
  const user = await requireUser()
  const book = await getBook(data && data.bookId)
  const access = await getAccess(user, book)
  if (!book || !access || !access.canManage) throw new Error('仅账本创建者或授权管理员可以处理通知')

  await db.collection(COLLECTIONS.notifications)
    .where({
      bookId: book._id,
      recipientOpenid: OPENID,
      read: false
    })
    .update({
      data: { read: true, updateTime: now() }
    })

  return stateResult(user, book, access)
}

async function clearNotifications(data) {
  const user = await requireUser()
  const book = await getBook(data && data.bookId)
  const access = await getAccess(user, book)
  if (!book || !access || !access.canManage) throw new Error('仅账本创建者或授权管理员可以清空通知')

  await db.collection(COLLECTIONS.notifications)
    .where({
      bookId: book._id,
      recipientOpenid: OPENID
    })
    .remove()

  return stateResult(user, book, access)
}

async function resetBook(data) {
  const user = await requireUser()
  const book = await getBook(data && data.bookId)
  const access = await getAccess(user, book)
  if (!book || !access || !access.canGrant) {
    throw new Error('仅账本创建者或后台管理员可以清空账本')
  }

  await Promise.all([
    db.collection(COLLECTIONS.members).where({ bookId: book._id }).remove(),
    db.collection(COLLECTIONS.bills).where({ bookId: book._id }).remove(),
    db.collection(COLLECTIONS.notifications).where({ bookId: book._id }).remove()
  ])
  await db.collection(COLLECTIONS.books).doc(book._id).update({
    data: {
      totalCount: 0,
      usedCount: 0,
      remainingCount: 0,
      updateTime: now()
    }
  })

  return stateResult(user, await getBook(book._id), access)
}

async function getInviteQr(data) {
  const user = await requireUser()
  const book = await getBook(data && data.bookId)
  const access = await getAccess(user, book)
  if (!book || !access || !access.canManage) throw new Error('仅账本创建者或授权管理员可以生成邀请二维码')

  const member = await getMemberInBook(book._id, data && data.memberId)
  if (!member) throw new Error('成员不存在')

  const envVersion = ['develop', 'trial', 'release'].indexOf(data && data.envVersion) !== -1
    ? data.envVersion
    : 'release'

  try {
    const result = await cloud.openapi.wxacode.getUnlimited({
      scene: `c${member.inviteCode}`,
      page: 'pages/member/index',
      checkPath: false,
      envVersion
    })

    return {
      ok: true,
      qrBase64: Buffer.from(result.buffer).toString('base64'),
      inviteCode: member.inviteCode,
      envVersion
    }
  } catch (error) {
    console.warn('生成小程序码失败：', error)
    return {
      ok: true,
      qrBase64: '',
      inviteCode: member.inviteCode,
      qrError: '小程序码生成失败，请改用邀请码分享'
    }
  }
}

async function sendSubscribeMessage(data) {
  if (!data || !data.adminOpenid) {
    return { ok: false, message: '未找到通知接收人' }
  }
  if (!SUBSCRIBE_TEMPLATE_ID) {
    return { ok: false, message: '未配置订阅消息模板 ID' }
  }

  try {
    await cloud.openapi.subscribeMessage.send({
      touser: data.adminOpenid,
      templateId: SUBSCRIBE_TEMPLATE_ID,
      page: 'pages/mine/index',
      data: {
        thing1: {
          value: `成员${cleanText(data.memberName, '成员')}核销${countValue(data.count)}次`
        },
        time2: {
          value: data.timeText || formatTime(now())
        }
      }
    })
    return { ok: true, message: '' }
  } catch (error) {
    // 应用内通知已经写入，订阅消息失败不影响核销结果。
    console.warn('管理员订阅消息发送失败：', error)
    return { ok: false, message: error.errMsg || error.message || '订阅消息发送失败' }
  }
}
async function main(event) {
  const action = event && event.action

  switch (action) {
    case 'login':
      return login(event)
    case 'getState':
      return getState(event)
    case 'myBooks':
      return listMyBooks()
    case 'createBook':
      return createBook(event)
    case 'updateProfile':
      return updateProfile(event)
    case 'bindMember':
      return bindMember(event)
    case 'addMember':
      return addMember(event)
    case 'grantPermission':
      return grantPermission(event)
    case 'addCount':
      return addCount(event)
    case 'consumeCount':
      return consumeCount(event)
    case 'removeMember':
      return removeMember(event)
    case 'markNotificationsRead':
      return markNotificationsRead(event)
    case 'clearNotifications':
      return clearNotifications(event)
    case 'resetBook':
      return resetBook(event)
    case 'getInviteQr':
      return getInviteQr(event)
    default:
      throw new Error('未知的云函数操作')
  }
}

exports.main = async (event) => {
  // 每次调用实时获取微信上下文，避免容器复用导致 OPENID 为空或串号。
  const wxContext = cloud.getWXContext()
  OPENID = (wxContext && wxContext.OPENID) || ''
  try {
    return await main(event || {})
  } catch (error) {
    console.error('book 云函数执行失败：', error)
    return {
      ok: false,
      message: error.message || '云端操作失败'
    }
  }
}