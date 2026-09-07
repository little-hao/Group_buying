/**
 * 拼单账本 - 小程序全局入口
 *
 * 数据策略：全部业务数据读写 VPS 自建 API（JSON 文档存储），
 * 不再依赖微信云开发。本地缓存只用于快速展示，写操作依赖服务端。
 *
 * 权限模型（服务端为准）：
 * - 用户在「我的」页微信登录/注册账户。
 * - 用户创建的账本自动成为该账本管理员（owner）。
 * - 后台管理员（platformAdmin，服务端 ADMIN_OPENIDS 配置）拥有最高权限。
 * - 同一账本内的成员默认仅查看成员与次数，账本创建者可授予核销/管理权限。
 */

const apiConfig = require('./utils/api-config.js')

const ACTION_ROUTES = {
  login: ['POST', '/login'],
  getState: ['GET', '/state'],
  myBooks: ['GET', '/books'],
  createBook: ['POST', '/books'],
  updateProfile: ['POST', '/profile'],
  bindMember: ['POST', '/bind'],
  addMember: ['POST', (data) => `/books/${data.bookId}/members`],
  grantPermission: ['PATCH', (data) => `/books/${data.bookId}/members/${data.memberId}/permissions`],
  addCount: ['POST', (data) => `/books/${data.bookId}/members/${data.memberId}/count`],
  consumeCount: ['POST', (data) => `/books/${data.bookId}/members/${data.memberId}/consume`],
  removeMember: ['DELETE', (data) => `/books/${data.bookId}/members/${data.memberId}`],
  markNotificationsRead: ['POST', (data) => `/books/${data.bookId}/notifications/read`],
  clearNotifications: ['DELETE', (data) => `/books/${data.bookId}/notifications`],
  resetBook: ['DELETE', (data) => `/books/${data.bookId}/reset`],
  getInviteQr: ['GET', (data) => `/invite-qr?bookId=${encodeURIComponent(data.bookId || '')}&memberId=${encodeURIComponent(data.memberId || '')}&envVersion=${encodeURIComponent(data.envVersion || 'release')}`]
}

App({
  SUBSCRIBE_TEMPLATE_ID: apiConfig.subscribeTemplateId,

  globalData: {
    userInfo: null,
    currentBookId: '',
    currentBook: null,
    role: 'none',
    permissions: { manage: false, consume: false },
    members: [],
    bills: [],
    notifications: [],
    myBooks: [],
    isLogin: false,
    platformAdmin: false,
    cloudReady: false,
    cloudError: '',
    isNewUser: false,
    loggedOut: false,
    authRetrying: false
  },

  onLaunch() {
    console.log('拼单账本 - 小程序启动')
    this.restoreLocalCache()
    this.readyPromise = this.bootstrapCloud()
  },

  onShow() {
    console.log('拼单账本 - 小程序进入前台')
  },

  onHide() {
    console.log('拼单账本 - 小程序进入后台')
  },

  /* ================= 本地缓存 ================= */

  cacheKey(bookId) {
    return `bookCache_${bookId}`
  },

  restoreLocalCache() {
    const savedUserInfo = wx.getStorageSync('userInfo') || {}
    this.globalData.userInfo = {
      name: savedUserInfo.name || '微信用户',
      userId: savedUserInfo.userId || '',
      avatarUrl: savedUserInfo.avatarUrl || '',
      platformAdmin: !!savedUserInfo.platformAdmin
    }
    this.globalData.isLogin = !!savedUserInfo.userId
    this.globalData.platformAdmin = !!savedUserInfo.platformAdmin

    const currentBookId = wx.getStorageSync('currentBookId') || ''
    this.globalData.currentBookId = currentBookId
    if (currentBookId) {
      const cache = wx.getStorageSync(this.cacheKey(currentBookId))
      if (cache && cache.book) this.applyState(cache.state)
    }
    this.globalData.myBooks = wx.getStorageSync('myBooks') || []
  },

  getLocalSnapshot() {
    const currentBookId = this.globalData.currentBookId
    const cache = currentBookId ? wx.getStorageSync(this.cacheKey(currentBookId)) : null
    const legacyBook = wx.getStorageSync('book') || null
    const members = (cache && cache.state.members) || wx.getStorageSync('members') || []
    const bills = (cache && cache.state.bills) || wx.getStorageSync('bills') || []
    const notifications = (cache && cache.state.notifications) || wx.getStorageSync('notifications') || []
    const book = (cache && cache.state.book) || legacyBook

    return {
      book,
      members,
      bills,
      notifications,
      hasData: !!(members.length || bills.length || notifications.length ||
        (book && (book.totalCount || book.usedCount || book.remainingCount)))
    }
  },

  /* ================= API 登录与请求 ================= */

  getToken() {
    return wx.getStorageSync('apiToken') || ''
  },

  getWxLoginCode() {
    return new Promise((resolve) => {
      wx.login({
        success: (res) => resolve(res.code || ''),
        fail: () => resolve('')
      })
    })
  },

  requestApi(method, path, data = {}, retryAuth = true) {
    return new Promise((resolve) => {
      const header = { 'content-type': 'application/json' }
      const token = this.getToken()
      if (token) header.Authorization = `Bearer ${token}`

      wx.request({
        url: apiConfig.API_BASE + path,
        method,
        data,
        header,
        success: async (res) => {
          const body = res.data || {}
          if (res.statusCode === 401 && body.code === 'UNAUTHORIZED' && retryAuth && !this.globalData.authRetrying) {
            this.globalData.authRetrying = true
            const ok = await this.loginSilently()
            this.globalData.authRetrying = false
            if (ok) {
              const retry = await this.requestApi(method, path, data, false)
              resolve(retry)
              return
            }
          }
          resolve(body)
        },
        fail: (error) => {
          resolve({
            ok: false,
            message: (error && error.errMsg) || '网络请求失败'
          })
        }
      })
    })
  },

  async loginSilently(profile = {}) {
    const code = await this.getWxLoginCode()
    if (!code) {
      this.globalData.cloudError = '微信登录 code 获取失败'
      return false
    }

    const saved = wx.getStorageSync('userInfo') || {}
    const result = await this.requestApi('POST', '/login', {
      code,
      profile: {
        name: profile.name || saved.name || '',
        avatarUrl: profile.avatarUrl || saved.avatarUrl || ''
      },
      bookId: this.globalData.currentBookId || '',
      localSnapshot: this.getLocalSnapshot()
    }, false)

    if (!result || !result.ok || !result.state) {
      this.globalData.cloudError = (result && result.message) || '登录失败'
      return false
    }

    if (result.token) {
      wx.setStorageSync('apiToken', result.token)
    }
    this.globalData.loggedOut = false
    this.globalData.cloudError = ''
    this.globalData.isNewUser = !!result.isNewUser
    this.applyState(result.state)
    return true
  },

  async bootstrapCloud() {
    try {
      const ok = await this.loginSilently()
      this.globalData.cloudReady = ok
      return ok
    } catch (error) {
      console.warn('API 登录失败：', error)
      this.globalData.cloudReady = false
      this.globalData.cloudError = (error && error.message) || '服务连接失败'
      return false
    }
  },

  ready() {
    return this.readyPromise || Promise.resolve(false)
  },

  async callCloudRaw(action, data = {}) {
    const route = ACTION_ROUTES[action]
    if (!route) {
      return { ok: false, message: `未知操作 ${action}` }
    }

    const method = route[0]
    const pathFactory = route[1]
    const path = typeof pathFactory === 'function' ? pathFactory(data) : pathFactory

    if (action === 'login' && !data.code) {
      data.code = await this.getWxLoginCode()
    }

    const response = await this.requestApi(method, path, data)
    return response || {}
  },

  async runCloud(action, data = {}) {
    try {
      const result = await this.callCloudRaw(action, data)
      if (!result.ok) throw new Error(result.message || '服务端操作失败')
      return result
    } catch (error) {
      console.error(`API ${action} 调用失败`, error)
      this.showToast(error.message || '网络异常，请稍后重试')
      return null
    }
  },

  async syncState() {
    if (!this.globalData.cloudReady || this.globalData.loggedOut) return false

    const result = await this.runCloud('getState', {
      bookId: this.globalData.currentBookId || ''
    })
    if (!result || !result.state) return false

    this.applyState(result.state)
    return true
  },

  async refreshMyBooks() {
    if (!this.globalData.cloudReady || this.globalData.loggedOut) return

    const result = await this.runCloud('myBooks')
    if (!result) return

    this.globalData.myBooks = result.myBooks || []
    wx.setStorageSync('myBooks', this.globalData.myBooks)
  },

  /* ================= 状态应用 ================= */

  applyState(state) {
    const user = state.user || {}
    const book = state.book || null

    const userInfo = {
      name: user.name || '微信用户',
      userId: user.userId || '',
      avatarUrl: user.avatarUrl || '',
      platformAdmin: !!user.platformAdmin
    }

    this.globalData.userInfo = userInfo
    this.globalData.isLogin = !!userInfo.userId
    this.globalData.platformAdmin = userInfo.platformAdmin
    this.globalData.currentBook = book
    this.globalData.role = state.role || 'none'
    this.globalData.permissions = state.permissions || { manage: false, consume: false }
    this.globalData.members = (state.members || []).map((member) => this.normalizeMember(member))
    this.globalData.bills = (state.bills || []).map((bill) => this.normalizeBill(bill))
    this.globalData.notifications = state.notifications || []
    this.globalData.myBooks = state.myBooks || []

    if (book && book.id) {
      this.globalData.currentBookId = book.id
      wx.setStorageSync('currentBookId', book.id)
    }

    wx.setStorageSync('userInfo', userInfo)
    wx.setStorageSync('myBooks', this.globalData.myBooks)

    if (book && book.id) {
      wx.setStorageSync(this.cacheKey(book.id), {
        state: {
          user,
          book,
          role: state.role || 'none',
          permissions: state.permissions || { manage: false, consume: false },
          members: state.members || [],
          bills: state.bills || [],
          notifications: state.notifications || [],
          myBooks: state.myBooks || []
        }
      })
    }
  },

  applyUserInfo(userInfo) {
    const normalized = {
      name: userInfo.name || '微信用户',
      userId: userInfo.userId || '',
      avatarUrl: userInfo.avatarUrl || '',
      platformAdmin: !!userInfo.platformAdmin
    }
    this.globalData.userInfo = normalized
    this.globalData.isLogin = !!normalized.userId
    this.globalData.platformAdmin = normalized.platformAdmin
    wx.setStorageSync('userInfo', normalized)
    return normalized
  },  /* ================= 登录 / 账户 ================= */

  async wechatLogin(profile = {}) {
    this.globalData.loggedOut = false
    if (!this.globalData.cloudReady) {
      const connected = await this.bootstrapCloud()
      if (!connected) return false
    }

    const result = await this.runCloud('login', {
      profile: {
        name: profile.name || '',
        avatarUrl: profile.avatarUrl || ''
      },
      bookId: this.globalData.currentBookId || ''
    })
    if (!result || !result.state) return false

    if (result.token) {
      wx.setStorageSync('apiToken', result.token)
    }
    this.globalData.isNewUser = !!result.isNewUser
    this.applyState(result.state)
    return true
  },

  async saveUserInfo(userInfo) {
    if (!this.globalData.cloudReady) {
      this.showToast('服务未连接，无法保存')
      return null
    }

    const result = await this.runCloud('updateProfile', {
      name: userInfo.name || '',
      avatarUrl: userInfo.avatarUrl || '',
      bookId: this.globalData.currentBookId || ''
    })
    if (!result || !result.state) return null

    this.applyState(result.state)
    return this.globalData.userInfo
  },

  async uploadAvatar(localPath) {
    if (!this.globalData.cloudReady || !localPath) return ''

    return new Promise((resolve) => {
      wx.getFileSystemManager().readFile({
        filePath: localPath,
        encoding: 'base64',
        success: async (res) => {
          const data = res.data || ''
          const extMatch = /\.(png|jpe?g|webp|gif)$/i.exec(localPath)
          const ext = extMatch ? extMatch[1].toLowerCase() : 'png'
          const result = await this.requestApi('POST', '/avatar', {
            data,
            ext
          }, true)

          if (result && result.ok && result.url) {
            resolve(result.url)
          } else {
            this.showToast('头像上传失败，请重试')
            resolve('')
          }
        },
        fail: () => {
          this.showToast('头像读取失败，请重试')
          resolve('')
        }
      })
    })
  },

  hasSubscribeTemplate() {
    return !!this.SUBSCRIBE_TEMPLATE_ID
  },

  logoutLocal() {
    wx.removeStorageSync('apiToken')
    wx.removeStorageSync('userInfo')
    wx.removeStorageSync('myBooks')
    wx.removeStorageSync('currentBookId')
    wx.removeStorageSync('book')
    wx.removeStorageSync('members')
    wx.removeStorageSync('bills')
    wx.removeStorageSync('notifications')
    wx.removeStorageSync('checkRecords')
    wx.removeStorageSync('adminUserId')
    this.globalData.loggedOut = true
    this.globalData.userInfo = null
    this.globalData.isLogin = false
    this.globalData.currentBook = null
    this.globalData.currentBookId = ''
    this.globalData.members = []
    this.globalData.bills = []
    this.globalData.myBooks = []
    this.globalData.role = 'none'
    this.globalData.permissions = { manage: false, consume: false }
  },

  /* ================= 权限 ================= */

  getCurrentUserId() {
    return (this.globalData.userInfo || {}).userId || ''
  },

  isPlatformAdmin() {
    return !!(this.globalData.userInfo && this.globalData.userInfo.platformAdmin)
  },

  isCurrentUserAdmin() {
    return this.canManageBook()
  },

  canManageBook() {
    return !!(this.globalData.permissions && this.globalData.permissions.manage)
  },

  canConsumeBook() {
    return !!(this.globalData.permissions && this.globalData.permissions.consume)
  },

  canConsumeMember(member) {
    if (this.canManageBook()) return true
    return !!(member && member.isMe && this.canConsumeBook())
  },

  getCurrentMember() {
    const userId = this.getCurrentUserId()
    if (!userId) return null
    return this.globalData.members.find((member) => member.isMe && member.userId === userId) || null
  },

  /* ================= 多账本 ================= */

  getCurrentBook() {
    return this.globalData.currentBook || {
      id: '',
      name: '尚未选择账本',
      totalCount: 0,
      usedCount: 0,
      remainingCount: 0
    }
  },

  async switchBook(bookId) {
    this.globalData.currentBookId = bookId || ''
    wx.setStorageSync('currentBookId', this.globalData.currentBookId)

    const cache = bookId ? wx.getStorageSync(this.cacheKey(bookId)) : null
    if (cache && cache.state) {
      this.globalData.currentBook = cache.state.book
      this.globalData.role = cache.state.role
      this.globalData.permissions = cache.state.permissions
      this.globalData.members = (cache.state.members || []).map((member) => this.normalizeMember(member))
      this.globalData.bills = (cache.state.bills || []).map((bill) => this.normalizeBill(bill))
      this.globalData.notifications = cache.state.notifications || []
    } else {
      this.globalData.currentBook = null
      this.globalData.role = 'none'
      this.globalData.permissions = { manage: false, consume: false }
      this.globalData.members = []
      this.globalData.bills = []
      this.globalData.notifications = []
    }

    if (this.globalData.cloudReady) {
      await this.syncState()
    }
    await this.refreshMyBooks()
    return this.globalData.currentBook
  },

  async createBook(name) {
    if (!this.globalData.cloudReady) {
      this.showToast('服务未连接，无法创建账本')
      return null
    }

    const result = await this.runCloud('createBook', {
      name: (name || '').trim() || '我的拼单账本'
    })
    if (!result || !result.state) return null

    this.applyState(result.state)
    await this.refreshMyBooks()
    return this.globalData.currentBook
  },

  async bindMemberByCode(inviteCode) {
    if (!this.globalData.cloudReady) {
      this.showToast('服务未连接，请先连接服务')
      return null
    }

    const result = await this.runCloud('bindMember', {
      inviteCode: String(inviteCode || '').trim()
    })
    if (!result || !result.state) return null

    this.applyState(result.state)
    if (result.bookId) {
      this.globalData.currentBookId = result.bookId
      wx.setStorageSync('currentBookId', result.bookId)
    }
    await this.refreshMyBooks()
    return this.getCurrentMember()
  },

  /* ================= 成员与次数操作 ================= */

  getMembers() {
    return this.globalData.members
  },

  getBills() {
    return this.globalData.bills
  },

  getNotifications() {
    return this.canManageBook() ? this.globalData.notifications : []
  },

  getUnreadNotificationCount() {
    return this.getNotifications().filter((item) => !item.read).length
  },  async addMember(name, initialCount = 0) {
    if (!this.canManageBook()) {
      this.showToast('仅账本创建者或授权管理员可以添加成员')
      return null
    }

    const count = Math.max(0, parseInt(initialCount, 10) || 0)
    const result = await this.runCloud('addMember', {
      bookId: this.globalData.currentBookId,
      name: (name || '').trim() || '未命名成员',
      count
    })
    if (!result || !result.state) return null

    this.applyState(result.state)
    return result.member || null
  },

  async grantPermission(memberId, consume = false, manage = false) {
    if (!this.canManageBook()) {
      this.showToast('仅账本创建者或后台管理员可以授予权限')
      return null
    }

    const result = await this.runCloud('grantPermission', {
      bookId: this.globalData.currentBookId,
      memberId,
      consume,
      manage
    })
    if (!result || !result.state) return null

    this.applyState(result.state)
    return true
  },

  async addCount(count = 1, memberId = '') {
    if (!this.canManageBook()) {
      this.showToast('仅账本创建者或授权管理员可以分配次数')
      return null
    }

    const num = Math.max(1, parseInt(count, 10) || 1)
    const result = await this.runCloud('addCount', {
      bookId: this.globalData.currentBookId,
      memberId,
      count: num
    })
    if (!result || !result.state) return null

    this.applyState(result.state)
    return result.operation || null
  },

  async consumeCount(count = 1, memberId = '', remark = '') {
    const num = Math.max(1, parseInt(count, 10) || 1)
    const member = this.getMembers().find((item) => item.id === memberId)

    if (!member) {
      this.showToast('请选择有效成员')
      return null
    }
    if (!this.canConsumeMember(member)) {
      this.showToast('您暂无该成员的核销权限')
      return null
    }

    const result = await this.runCloud('consumeCount', {
      bookId: this.globalData.currentBookId,
      memberId,
      count: num,
      remark
    })
    if (!result || !result.state) return null

    this.applyState(result.state)
    return result.operation || null
  },

  async removeMember(memberId) {
    if (!this.canManageBook()) {
      this.showToast('仅账本创建者或后台管理员可以删除成员')
      return null
    }

    const result = await this.runCloud('removeMember', {
      bookId: this.globalData.currentBookId,
      memberId
    })
    if (!result || !result.state) return null

    this.applyState(result.state)
    return result.member || null
  },

  async markNotificationsRead() {
    if (!this.canManageBook()) {
      this.showToast('仅账本创建者或授权管理员可以处理通知')
      return false
    }

    const result = await this.runCloud('markNotificationsRead', {
      bookId: this.globalData.currentBookId
    })
    if (!result || !result.state) return false

    this.applyState(result.state)
    return true
  },

  async clearNotifications() {
    if (!this.canManageBook()) {
      this.showToast('仅账本创建者或授权管理员可以清空通知')
      return false
    }

    const result = await this.runCloud('clearNotifications', {
      bookId: this.globalData.currentBookId
    })
    if (!result || !result.state) return false

    this.applyState(result.state)
    return true
  },

  async resetBook() {
    if (!this.canManageBook()) {
      this.showToast('仅账本创建者或后台管理员可以清空账本')
      return false
    }

    const result = await this.runCloud('resetBook', {
      bookId: this.globalData.currentBookId
    })
    if (!result || !result.state) return false

    this.applyState(result.state)
    return true
  },

  async getInviteQr(memberId, envVersion = 'release') {
    if (!this.canManageBook()) return null

    const result = await this.runCloud('getInviteQr', {
      bookId: this.globalData.currentBookId,
      memberId,
      envVersion
    })
    if (!result) return null

    if (!result.qrBase64) {
      return {
        path: '',
        inviteCode: result.inviteCode || '',
        qrError: result.qrError || '小程序码生成失败'
      }
    }

    const filePath = `${wx.env.USER_DATA_PATH}/invite_${Date.now()}.png`
    await new Promise((resolve) => {
      wx.getFileSystemManager().writeFile({
        filePath,
        data: result.qrBase64,
        encoding: 'base64',
        success: resolve,
        fail: resolve
      })
    })
    return {
      path: filePath,
      inviteCode: result.inviteCode || '',
      qrError: ''
    }
  },

  requestAdminNotificationPermission() {
    if (!this.canManageBook()) {
      this.showToast('仅账本创建者或授权管理员可以开启通知')
      return
    }

    const templateId = this.SUBSCRIBE_TEMPLATE_ID
    if (!templateId) {
      this.showToast('请先配置订阅消息模板 ID')
      return
    }

    wx.showModal({
      title: '开启微信通知',
      content: '授权一次可推送一条核销通知；成员每次核销后如需再次提醒，请再次点按开启。未开启时仍可在本页查看应用内通知。',
      confirmText: '去授权',
      success: (modal) => {
        if (!modal.confirm) return

        wx.requestSubscribeMessage({
          tmplIds: [templateId],
          success: (res) => {
            if (res[templateId] === 'accept') {
              this.showToast('已授权', 'success')
            } else {
              this.showToast('未同意订阅，仍可在应用内查看通知')
            }
          },
          fail: () => {
            this.showToast('订阅消息授权失败')
          }
        })
      }
    })
  },

  /* ================= 工具 ================= */

  normalizeMember(member) {
    return {
      ...member,
      id: member.id || member._id || '',
      userId: member.userId || member.userOpenid || '',
      inviteCode: member.inviteCode || '',
      totalCount: Number(member.totalCount) || 0,
      usedCount: Number(member.usedCount) || 0,
      remainingCount: Number(member.remainingCount) || 0,
      permissions: member.permissions || { consume: false, manage: false },
      bound: !!member.bound || !!member.userId,
      isMe: !!member.isMe || (!!member.userId && member.userId === this.getCurrentUserId())
    }
  },

  normalizeBill(bill) {
    return {
      ...bill,
      id: bill.id || bill._id || ''
    }
  },

  showToast(title, icon = 'none') {
    wx.showToast({
      title,
      icon,
      duration: 1800
    })
  },

  navigateTo(url) {
    wx.navigateTo({ url })
  },

  navigateBack() {
    wx.navigateBack({ delta: 1 })
  }
})