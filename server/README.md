# 拼单账本 VPS API

自建 Node.js API 替代微信云开发。Express 单进程 + 本地 JSON 文档集合 +
本地对象目录，通过 Nginx 反代到 https://hao.19990920.xyz。

## 目录

- `server.js`：接口与业务逻辑入口
- `lib/store.js`：JSON 文档集合（原子落盘）
- `lib/wechat.js`：jscode2session / access_token / 订阅消息 / 小程序码
- `data/*.json`：业务数据（备份此目录即可）
- `objects/`：头像等上传对象（备份此目录即可）

## 接口

与小程序端 `utils/api-config.js` 的 API_BASE 对齐，全部返回 JSON：

- `GET /health`
- `POST /login`：wx.login code 换 openid，注册 + 发 token
- `GET /state?bookId=` / `GET /books`
- `POST /books` / `POST /bind`
- `POST /books/:id/members` / `PATCH .../members/:mid/permissions`
- `POST .../members/:mid/count`（二次分配）/ `POST .../members/:mid/consume`
- `DELETE .../members/:mid`
- `POST /books/:id/notifications/read` / `DELETE /books/:id/notifications`
- `DELETE /books/:id/reset`
- `POST /profile` / `POST /avatar`（base64，返回 /api/files/... 对象 URL）
- `GET /invite-qr`（通过微信接口生成小程序码；失败时客户端回退邀请码）

除 login/health 外均需请求头 `Authorization: Bearer <token>`。

## VPS 部署（aaPanel）

1. 上传 `server/` 到 VPS，例如 `/www/wwwroot/pin-dan-api`。
2. 安装依赖并启动：

```bash
cd /www/wwwroot/pin-dan-api
npm install --production
npm install -g pm2   # 或使用 aaPanel Node 项目守护
pm2 start server.js --name pin-dan-api
pm2 save
```

3. 配置环境变量（aaPanel Node 项目或 `.env` 导入后 source）：
   `WEAPP_APPID`、`WEAPP_SECRET`、`ADMIN_OPENIDS`、`PUBLIC_BASE_URL`。
4. aaPanel 网站 `hao.19990920.xyz` 的 Nginx 增加反代：

```nginx
location /api/ {
  # 关键：剥离 /api 前缀，Node 服务路由本身不带 /api
  proxy_pass http://127.0.0.1:3000/;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

5. `nginx -t` 后 reload；访问
   `https://hao.19990920.xyz/api/health` 应返回 `{"ok":true}`。
6. 备份：aaPanel 备份 `/www/wwwroot/pin-dan-api/data` 与 `objects`；
   落盘为原子写入，可直接定时复制。

## 小程序端配置

- `utils/api-config.js` 中 `API_BASE` 已指向 `https://hao.19990920.xyz/api`。
- 微信公众平台「开发管理-开发设置-服务器域名」添加：
  - request 合法域名：`https://hao.19990920.xyz`
  - uploadFile 合法域名：`https://hao.19990920.xyz`
  - downloadFile 合法域名：`https://hao.19990920.xyz`
- 开发工具里勾选「不校验合法域名」可先本地联调。

## 本地联调

```bash
cd server
npm install
PORT=3000 ALLOW_DEV_LOGIN=true DEV_OPENID=dev_openid node server.js
```

然后用任意 `code` 调 `POST /login` 即可得到 dev_openid 账号与 token。
生产环境务必关闭 `ALLOW_DEV_LOGIN` 并配置真实 AppSecret。