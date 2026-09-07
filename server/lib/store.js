/**
 * 轻量 JSON 文档集合
 *
 * - 内存中读写，单进程串行执行。
 * - 每次变更同步落盘（写临时文件后原子改名），进程重启不丢数据。
 * - 备份只需复制 data/ 目录。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const COLLECTIONS = ['users', 'books', 'members', 'bills', 'notifications', 'sessions']

class JsonStore {
  constructor(dir) {
    this.dir = dir
    this.data = {}
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true })
    for (const name of COLLECTIONS) {
      const file = path.join(this.dir, `${name}.json`)
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, '[]\n')
      }
      this.data[name] = JSON.parse(fs.readFileSync(file, 'utf8'))
    }
  }

  _file(name) {
    return path.join(this.dir, `${name}.json`)
  }

  id(prefix) {
    return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  }

  raw(name) {
    return this.data[name] || []
  }

  all(name) {
    return this.data[name] || []
  }

  find(name, predicate) {
    return this.all(name).filter(predicate)
  }

  one(name, predicate) {
    return this.all(name).find(predicate) || null
  }

  insert(name, doc) {
    if (!doc._id) doc._id = this.id(name === 'sessions' ? 'session' : name)
    this.data[name].push(doc)
    this.persist(name)
    return doc
  }

  updateMany(name, predicate, patch) {
    let changed = false
    for (const doc of this.data[name]) {
      if (predicate(doc)) {
        Object.assign(doc, patch)
        changed = true
      }
    }
    if (changed) this.persist(name)
    return changed
  }

  updateOne(name, predicate, patch) {
    const doc = this.one(name, predicate)
    if (!doc) return null
    Object.assign(doc, patch)
    this.persist(name)
    return doc
  }

  removeMany(name, predicate) {
    const before = this.data[name].length
    this.data[name] = this.data[name].filter((doc) => !predicate(doc))
    if (this.data[name].length !== before) this.persist(name)
    return before - this.data[name].length
  }

  removeOne(name, predicate) {
    const index = this.data[name].findIndex(predicate)
    if (index === -1) return false
    this.data[name].splice(index, 1)
    this.persist(name)
    return true
  }

  persist(names) {
    const list = Array.isArray(names) ? names : [names]
    for (const name of list) {
      const file = this._file(name)
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data[name], null, 2) + '\n')
      fs.renameSync(tmp, file)
    }
  }
}

module.exports = { JsonStore, COLLECTIONS }