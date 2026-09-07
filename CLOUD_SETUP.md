# 拼单账本部署（VPS 自建）

本项目已从微信云开发迁移到 VPS 自建 Node.js API：

- API Base：https://hao.19990920.xyz/api
- 小程序端配置：[utils/api-config.js](utils/api-config.js)
- 服务端完整说明与部署步骤：[server/README.md](server/README.md)

## 快速步骤

1. 将 `server/` 上传到 VPS，执行 `npm install --production`。
2. 配置环境变量：`WEAPP_APPID=wx10225c126a8d34b6`、
   `WEAPP_SECRET=你的AppSecret`、`ADMIN_OPENIDS`。
3. 用 pm2 / aaPanel Node 项目守护 `node server.js`。
4. 在 aaPanel 的 `hao.19990920.xyz` Nginx 中把 `/api/` 反代到
   `http://127.0.0.1:3000`（配置片段见 server/README.md）。
5. 微信公众平台把 `https://hao.19990920.xyz` 加入
   request / uploadFile / downloadFile 合法域名。
6. 备份只需复制 `server/data` 与 `server/objects`。

`cloudfunctions/` 目录保留为旧云开发时代归档，已不再参与小程序编译与部署。