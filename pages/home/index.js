/**
 * 拼单账本：首页
 *
 * 功能：
 * 1. 当前账本统计
 * 2. 有权限时的快速核销
 * 3. 最近核销记录与未读通知
 */

const app = getApp()

Page({
  data: {
    book: null,
    roleText: '',
    canManage: false,
    canConsume: false,
    members: [],
    recentRecords: [],
    unreadCount: 0,
    showPicker: false
  },

  onShow() {
    this.refreshData()
  },

  async refreshData() {
    await app.ready()
    await app.syncState()

    const canManage = app.canManageBook()
    const canConsume = app.canConsumeBook()
    const currentMember = app.getCurrentMember()

    let members = []
    if (canManage) {
      members = app.getMembers()
    } else if (canConsume && currentMember) {
      members = [currentMember]
    }

    const bills = app.getBills()
    const recentRecords = bills
      .filter((bill) => bill.type === 'consume')
      .slice(0, 5)
    const displayMembers = members.map((item) => ({
      ...item,
      initial: (item.name || '?').slice(0, 1)
    }))

    this.setData({
      book: app.getCurrentBook(),
      roleText: this.roleText(),
      canManage,
      canConsume,
      members: displayMembers,
      recentRecords,
      unreadCount: canManage ? app.getUnreadNotificationCount() : 0
    })
  },

  roleText() {
    const role = app.globalData.role || 'none'
    const map = {
      platform: '后台管理员',
      owner: '创建者',
      manager: '管理员',
      member: '成员',
      none: '未加入'
    }
    return map[role] || ''
  },

  handleQuickConsume() {
    const members = this.data.members
    if (!members.length) {
      app.showToast(this.data.canManage ? '请先在成员页添加成员' : '您暂无可用核销次数')
      return
    }

    if (!this.data.canManage) {
      this.consumeForMember(members[0])
      return
    }

    this.setData({ showPicker: true })
  },

  handlePickMember(event) {
    const id = event.currentTarget.dataset.id
    const member = this.data.members.find((item) => item.id === id)
    this.setData({ showPicker: false })
    if (member) this.consumeForMember(member)
  },

  handleClosePicker() {
    this.setData({ showPicker: false })
  },

  noop() {},

  consumeForMember(member) {
    if (!member || member.remainingCount <= 0) {
      app.showToast(`「${member.name}」暂无剩余次数`)
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

        const result = await app.consumeCount(count, member.id, '首页快速核销')
        if (!result) return

        await this.refreshData()
        wx.showToast({ title: '核销成功', icon: 'success' })
      }
    })
  },

  goMemberPage() {
    wx.switchTab({ url: '/pages/member/index' })
  },

  goMinePage() {
    wx.switchTab({ url: '/pages/mine/index' })
  }
})