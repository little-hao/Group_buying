/**
 * 拼单账本：我的页面
 *
 * 功能：
 * 1. 微信登录/注册，可选微信头像与昵称完善资料
 * 2. 创建/切换账本
 * 3. 通知中心与订阅消息状态
 */

const app = getApp()

const ROLE_TEXT = {
  platform: '后台管理员',
  owner: '创建者',
  manager: '管理员',
  member: '成员',
  none: '未加入'
}

Page({
  data: {
    cloudReady: false,
    cloudError: '',
    isLogin: false,
    showProfileEditor: false,
    avatarText: '我',
    avatarDraft: '',
    nicknameDraft: '',
    userInfo: {
      name: '微信用户',
      avatarUrl: '',
      platformAdmin: false
    },
    book: null,
    role: 'none',
    roleText: '',
    canManage: false,
    myBooks: [],
    notifications: [],
    unreadCount: 0,
    templateConfigured: false
  },

  onShow() {
    this.loadData()
  },

  async loadData() {
    await app.ready()
    if (app.globalData.cloudReady && !app.globalData.loggedOut) {
      await app.syncState()
      await app.refreshMyBooks()
    }

    const userInfo = app.globalData.userInfo || {
      name: '微信用户',
      userId: '',
      avatarUrl: '',
      platformAdmin: false
    }
    const book = app.getCurrentBook()
    const canManage = app.canManageBook()
    const myBooks = (app.globalData.myBooks || []).map((item) => ({
      ...item,
      roleText: ROLE_TEXT[item.role] || '成员',
      active: item.id === app.globalData.currentBookId
    }))

    this.setData({
      cloudReady: app.globalData.cloudReady,
      cloudError: app.globalData.cloudError || '',
      isLogin: app.globalData.isLogin,
      avatarText: (userInfo.name || '我').slice(0, 1),
      userInfo,
      book,
      role: app.globalData.role,
      roleText: ROLE_TEXT[app.globalData.role] || '',
      canManage,
      myBooks,
      notifications: canManage ? app.getNotifications() : [],
      unreadCount: canManage ? app.getUnreadNotificationCount() : 0,
      templateConfigured: app.hasSubscribeTemplate(),
      nicknameDraft: (userInfo.name && userInfo.name !== '微信用户') ? userInfo.name : ''
    })
  },

  /* ================= 微信登录 ================= */

  handleWechatLogin() {
    wx.showLoading({ title: '登录中' })
    app.wechatLogin().then((ok) => {
      wx.hideLoading()
      if (!ok) return

      const profileEmpty = !(app.globalData.userInfo && app.globalData.userInfo.name &&
        app.globalData.userInfo.name !== '微信用户') ||
        !(app.globalData.userInfo && app.globalData.userInfo.avatarUrl)

      app.showToast('登录成功', 'success')
      this.loadData().then(() => {
        this.setData({ showProfileEditor: profileEmpty })
      })
    })
  },

  handleRetryCloud() {
    app.globalData.cloudReady = false
    app.readyPromise = app.bootstrapCloud().then(() => {
      this.loadData()
    })
  },

  toggleProfileEditor() {
    this.setData({ showProfileEditor: !this.data.showProfileEditor })
  },

  /* ================= 头像昵称 ================= */

  handleChooseAvatar(event) {
    const path = event.detail && event.detail.avatarUrl
    if (!path) return
    this.setData({ avatarDraft: path })
  },

  handleNicknameInput(event) {
    this.setData({ nicknameDraft: event.detail.value })
  },

  async handleSaveProfile() {
    const name = (this.data.nicknameDraft || '').trim()
    if (!name) {
      app.showToast('请填写昵称')
      return
    }

    wx.showLoading({ title: '保存中' })
    let avatarUrl = (this.data.userInfo && this.data.userInfo.avatarUrl) || ''
    if (this.data.avatarDraft) {
      const fileID = await app.uploadAvatar(this.data.avatarDraft)
      if (fileID) avatarUrl = fileID
    }
    const saved = await app.saveUserInfo({ name, avatarUrl })
    wx.hideLoading()

    if (!saved) return

    this.setData({ avatarDraft: '', showProfileEditor: false })
    await this.loadData()
    wx.showToast({ title: '资料已保存', icon: 'success' })
  },

  /* ================= 账本 ================= */

  handleCreateBook() {
    if (!this.data.isLogin) {
      app.showToast('请先微信登录')
      return
    }

    wx.showModal({
      title: '创建账本',
      editable: true,
      placeholderText: '例如：健身房年卡拼单',
      content: '',
      success: async (res) => {
        if (!res.confirm) return

        const name = (res.content || '').trim()
        if (!name) {
          app.showToast('账本名称不能为空')
          return
        }

        const book = await app.createBook(name)
        if (!book) return

        app.showToast('账本已创建', 'success')
        wx.switchTab({ url: '/pages/home/index' })
      }
    })
  },

  handlePickBook(event) {
    const id = event.currentTarget.dataset.id
    if (!id) return

    app.switchBook(id).then(() => {
      wx.switchTab({ url: '/pages/home/index' })
    })
  },

  /* ================= 通知 ================= */

  handleReadAll() {
    if (!this.data.unreadCount) {
      app.showToast('暂无未读通知')
      return
    }

    app.markNotificationsRead().then(() => {
      this.loadData()
      app.showToast('已全部标记为已读')
    })
  },

  handleClearNotifications() {
    if (!this.data.notifications.length) {
      app.showToast('暂无通知')
      return
    }

    wx.showModal({
      title: '清空通知',
      content: '确定清空当前账本的所有通知记录吗？',
      confirmColor: '#FF3B30',
      success: async (res) => {
        if (!res.confirm) return
        await app.clearNotifications()
        await this.loadData()
        wx.showToast({ title: '已清空', icon: 'success' })
      }
    })
  },

  handleEnableNotifications() {
    app.requestAdminNotificationPermission()
  },

  handleLogout() {
    wx.showModal({
      title: '退出登录',
      content: '仅清除本机登录缓存，云端账户与账本数据不会删除。',
      confirmColor: '#FF3B30',
      success: (res) => {
        if (!res.confirm) return
        app.logoutLocal()
        this.setData({ isLogin: false, showProfileEditor: false })
        this.loadData()
      }
    })
  },

  handleClearCache() {
    if (!this.data.canManage) {
      app.showToast('仅账本创建者或后台管理员可以清空账本')
      return
    }

    wx.showModal({
      title: '清理测试数据',
      content: '将清空当前账本的成员、账单、通知和次数，是否继续？',
      confirmColor: '#FF3B30',
      success: async (res) => {
        if (!res.confirm) return
        await app.resetBook()
        await this.loadData()
        wx.showToast({ title: '已清理', icon: 'success' })
      }
    })
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/index' })
  }
})