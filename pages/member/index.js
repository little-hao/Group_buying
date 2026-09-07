/**
 * 拼单账本：成员管理 + 账单页
 *
 * 功能：
 * 1. 账本内成员与次数一览（成员默认可查看）
 * 2. 创建者/授权管理员：添加成员、二次分配、核销、删除、邀请二维码
 * 3. 创建者/后台管理员：授予成员核销或管理权限
 * 4. 普通成员：仅查看；被授予核销权限后可核销自己的次数
 * 5. 支持扫码（小程序码 scene）直接绑定邀请码
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
    book: null,
    role: 'none',
    roleText: '',
    canManage: false,
    canGrant: false,
    canConsume: false,
    members: [],
    bills: [],
    currentMember: null,
    showBindPanel: false,
    inviteCodeInput: '',
    qrPanelVisible: false,
    qrPath: '',
    qrInviteCode: '',
    qrMemberName: ''
  },

  onLoad(options) {
    const scene = (options && options.scene) ? decodeURIComponent(options.scene) : ''
    const code = (options && options.code) || ''
    if (/^c\d{6}$/.test(scene)) {
      this.pendingCode = scene.slice(1)
    } else if (/^\d{6}$/.test(code)) {
      this.pendingCode = code
    }
  },

  onShow() {
    this.refreshData()
  },

  async refreshData() {
    await app.ready()

    if (this.pendingCode && app.globalData.cloudReady) {
      const code = this.pendingCode
      this.pendingCode = ''
      await this.tryBindCode(code)
    }

    await app.syncState()
    await app.refreshMyBooks()

    const book = app.getCurrentBook()
    const canManage = app.canManageBook()
    const canGrant = canManage && (app.globalData.role === 'owner' || app.globalData.role === 'platform')
    const currentMember = app.getCurrentMember()

    this.setData({
      book,
      role: app.globalData.role,
      roleText: ROLE_TEXT[app.globalData.role] || '',
      canManage,
      canGrant,
      canConsume: app.canConsumeBook(),
      members: app.getMembers().map((item) => ({ ...item, initial: (item.name || '?').slice(0, 1) })),
      bills: app.getBills(),
      currentMember
    })
  },

  async tryBindCode(code) {
    if (!code) return
    const member = await app.bindMemberByCode(code)
    if (!member) return
    wx.showToast({ title: '加入账本成功', icon: 'success' })
    await this.refreshData()
  },

  /* ================= 绑定成员 ================= */

  handleShowBindPanel() {
    if (app.canManageBook()) {
      app.showToast('您是账本创建者或管理员，无需绑定成员')
      return
    }
    this.setData({
      showBindPanel: true,
      inviteCodeInput: ''
    })
  },

  handleCloseBindPanel() {
    this.setData({ showBindPanel: false })
  },

  handleInviteCodeInput(event) {
    this.setData({ inviteCodeInput: event.detail.value })
  },

  async handleBindMember() {
    const member = await app.bindMemberByCode(this.data.inviteCodeInput)
    if (!member) return

    this.setData({ showBindPanel: false })
    await this.refreshData()
    wx.showToast({ title: '绑定成功', icon: 'success' })
  },

  /* ================= 添加成员 ================= */

  handleAddMember() {
    if (!this.data.canManage) {
      app.showToast('仅账本创建者或授权管理员可以添加成员')
      return
    }

    wx.showModal({
      title: '添加成员',
      editable: true,
      placeholderText: '请输入成员名称',
      success: (res) => {
        if (!res.confirm) return
        const name = (res.content || '').trim()
        if (!name) {
          app.showToast('成员名称不能为空')
          return
        }
        this.askInitialCount(name)
      }
    })
  },

  askInitialCount(name) {
    wx.showModal({
      title: '设置初始次数',
      content: `为「${name}」设置初始次数（0 表示不充值）`,
      editable: true,
      placeholderText: '0',
      success: async (res) => {
        if (!res.confirm) return
        const count = parseInt(res.content || '0', 10)
        const validCount = isNaN(count) || count < 0 ? 0 : count

        const member = await app.addMember(name, validCount)
        if (!member) return

        await this.refreshData()
        wx.showModal({
          title: '成员已添加',
          content: `请把邀请码 ${member.inviteCode} 或邀请二维码发给「${member.name}」绑定。`,
          showCancel: false
        })
      }
    })
  },

  /* ================= 成员操作 ================= */

  handleMemberTap(event) {
    const id = event.currentTarget.dataset.id
    const member = this.data.members.find((item) => item.id === id)
    if (!member) return

    if (this.data.canManage) {
      const itemList = ['核销次数', '分配次数']
      if (!member.bound) itemList.push('邀请码 / 二维码')
      if (this.data.canGrant && member.bound) itemList.push('权限管理')
      if (itemList.length <= 1) return

      wx.showActionSheet({
        itemList,
        success: (res) => {
          if (res.tapIndex === 0) {
            this.handleConsume(member)
          } else if (res.tapIndex === 1) {
            this.handleRecharge(member)
          } else if (!member.bound && res.tapIndex === 2) {
            this.handleShowQr(member)
          } else if (this.data.canGrant && member.bound && res.tapIndex === 2) {
            this.handleManagePermission(member)
          }
        }
      })
      return
    }

    if (member.isMe && this.data.canConsume) {
      this.handleConsume(member)
    } else if (member.isMe) {
      app.showToast('当前为查看权限，核销需账本创建者授权')
    }
  },

  handleDeleteMember(event) {
    if (!this.data.canGrant) {
      app.showToast('仅账本创建者或后台管理员可以删除成员')
      return
    }

    const id = event.currentTarget.dataset.id
    const member = this.data.members.find((item) => item.id === id)
    if (!member) return

    wx.showModal({
      title: '删除成员',
      content: `确定删除「${member.name}」吗？\n剩余 ${member.remainingCount} 次将退回账本。`,
      confirmColor: '#E05A4E',
      success: async (res) => {
        if (!res.confirm) return
        await app.removeMember(id)
        await this.refreshData()
        wx.showToast({ title: '已删除', icon: 'success' })
      }
    })
  },

  handleConsume(member) {
    if (!member || member.remainingCount <= 0) {
      app.showToast(`「${member.name || '该成员'}」暂无剩余次数`)
      return
    }

    wx.showModal({
      title: `核销 · ${member.name}`,
      content: `剩余 ${member.remainingCount} 次，请输入本次核销次数`,
      editable: true,
      placeholderText: '1',
      success: async (res) => {
        if (!res.confirm) return
        const count = parseInt(res.content || '1', 10)
        if (isNaN(count) || count <= 0) {
          app.showToast('请输入有效次数')
          return
        }
        const result = await app.consumeCount(count, member.id, '成员核销')
        if (!result) return
        await this.refreshData()
        wx.showToast({ title: '核销成功', icon: 'success' })
      }
    })
  },

  handleRecharge(member) {
    if (!this.data.canManage) {
      app.showToast('仅账本创建者或授权管理员可以分配次数')
      return
    }

    wx.showModal({
      title: `二次分配 · ${member.name}`,
      content: '请输入要追加分配的次数',
      editable: true,
      placeholderText: '10',
      success: async (res) => {
        if (!res.confirm) return
        const count = parseInt(res.content || '0', 10)
        if (isNaN(count) || count <= 0) {
          app.showToast('请输入有效次数')
          return
        }
        const result = await app.addCount(count, member.id)
        if (!result) return
        await this.refreshData()
        wx.showToast({ title: '分配成功', icon: 'success' })
      }
    })
  },

  /* ================= 权限授予 ================= */

  handleManagePermission(member) {
    if (!this.data.canGrant) {
      app.showToast('仅账本创建者或后台管理员可以授予权限')
      return
    }

    const itemList = []
    itemList.push(member.permissions.consume ? '关闭核销权限' : '开启核销权限')
    itemList.push(member.permissions.manage ? '关闭管理权限' : '开启管理权限')

    wx.showActionSheet({
      itemList,
      success: async (res) => {
        if (res.tapIndex === 0) {
          if (member.permissions.consume) {
            await app.grantPermission(member.id, false, member.permissions.manage)
          } else {
            await app.grantPermission(member.id, true, member.permissions.manage)
          }
        } else if (res.tapIndex === 1) {
          await app.grantPermission(member.id, !member.permissions.manage, !member.permissions.manage)
        } else {
          return
        }

        await this.refreshData()
        app.showToast('权限已更新', 'success')
      }
    })
  },

  /* ================= 邀请二维码 ================= */

  async handleShowQr(member) {
    if (!member) return

    wx.showLoading({ title: '生成二维码中' })
    let result = null
    for (const envVersion of ['release', 'trial', 'develop']) {
      result = await app.getInviteQr(member.id, envVersion)
      if (result && result.path) break
    }
    wx.hideLoading()

    if (!result) return

    if (result.path) {
      this.setData({
        qrPanelVisible: true,
        qrPath: result.path,
        qrInviteCode: result.inviteCode,
        qrMemberName: member.name
      })
      return
    }

    wx.showModal({
      title: `邀请「${member.name}」`,
      content: `邀请码：${result.inviteCode || member.inviteCode}\n\n${result.qrError || '二维码生成失败，可先用邀请码分享'}`,
      showCancel: false
    })
  },

  handleCloseQr() {
    this.setData({ qrPanelVisible: false })
  },

  noop() {},

  goMinePage() {
    wx.switchTab({ url: '/pages/mine/index' })
  }
})