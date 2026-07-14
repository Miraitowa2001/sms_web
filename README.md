# 管理服务

基于API文档开发的设备管理服务，用于接收开发板推送的消息并提供管理功能。

## 功能特性

- ✅ 接收开发板推送的各类消息（联网、短信、通话等）
- ✅ 设备管理（自动注册、状态跟踪、离线检测）
- ✅ SIM卡信息管理
- ✅ 短信记录存储和查询
- ✅ 通话记录存储和查询
- ✅ 消息日志记录
- ✅ Web管理界面
- ✅ RESTful API
- ✅ HTTP直连 + TCP长连接双协议控制

## 支持的消息类型

| 类型 | 说明 | 类型 | 说明 |
|-----|------|-----|------|
| 100 | WIFI已联网 | 501 | 新短信 |
| 101 | 卡槽1已联网 | 502 | 短信外发成功 |
| 102 | 卡槽2已联网 | 601 | 来电振铃 |
| 202 | SIM卡注册中 | 602 | 来电接通 |
| 203 | SIM卡ID获取 | 603 | 对方挂断 |
| 204 | SIM卡就绪 | 620-623 | 去电相关 |
| 205 | SIM卡弹出 | 998 | PING心跳 |
| 209 | SIM卡异常 | ... | ... |

## 🚀 快速部署 (推荐)

本项目支持 Docker 一键部署，无需安装 Node.js 环境。

### Windows 用户
双击运行项目根目录下的 `start.bat` 脚本即可。

### Linux / macOS 用户
在终端运行：
```bash
chmod +x start.sh
./start.sh
```

服务启动后，访问管理界面：
- 地址: `http://localhost:36001`
- 默认账号: `admin`
- 默认密码: 请查看 `.env` 文件 (首次运行会自动生成)

> 更多 Docker 配置详情（如数据持久化、故障排查），请参阅 [Docker 部署指南](DOCKER_DEPLOY.md)。

---

## 🛠️ 手动部署 (开发环境)

如果您需要修改代码或进行二次开发，可以使用 Node.js 直接运行。

### 1. 安装依赖

```bash
cd sms_web
npm install
```

### 2. 启动服务

```bash
npm start
```

或开发模式（自动重启）：
```bash
npm run dev
```

### 3. 配置开发板

在开发板后台管理页面中，配置接口信息：

- **接口地址**: 
  - Docker部署: `http://你的服务器IP:36001/push`
  - 手动部署: `http://你的服务器IP:3000/push`
- **HTTP请求方式**: `POST`
- **Content-Type**: `application/json`（推荐）

如果使用 Form 格式：
- **接口地址**: `.../push-form`
- **Content-Type**: `application/x-www-form-urlencoded`

### 4. 访问管理界面

- Docker部署: `http://localhost:36001`
- 手动部署: `http://localhost:3000`

## 📚 API 接口文档

本服务提供了一套完整的 RESTful API，用于设备管理、数据查询及远程控制。

### 1. 鉴权说明

所有管理类 API（`/api/*`）均需要进行身份验证。

- **认证方式**: HTTP Basic Auth
- **默认账号**: `admin`
- **默认密码**: `admin123` (可在 `.env` 或 `src/config.js` 中修改)

在请求 Header 中添加：
```http
Authorization: Basic YWRtaW46YWRtaW4xMjM=
```
*(其中 `YWRtaW46YWRtaW4xMjM=` 是 `admin:admin123` 的 Base64 编码)*

### 2. 远程控制 API (核心)

用于向设备发送指令。**特别说明：`deviceIp` 参数支持直接填写 `设备ID`，系统会自动查找该设备最后一次上报的 IP 地址，解决公网部署时无法固定局域网 IP 的问题。**

#### 2.1 获取控制 Token
控制指令需要 Token 进行安全校验。X 系列新版固件的算法为
`MD5("admin|管理员密码")`，输出 32 位小写十六进制；设备 ID 不参与计算。

- **接口**: `GET /api/control/token`
- **参数**:
  - `username`: 管理员用户名 (默认 admin)
  - `password`: 管理员密码 (默认 admin)
- **返回**: `{ "success": true, "data": { "token": "..." } }`

#### 2.2 通用控制接口
发送任意指令到设备。

- **接口**: `POST /api/control/send`
- **Content-Type**: `application/json`
- **Body**:
```json
{
  "deviceIp": "dev001",      // 支持填写 设备ID (推荐) 或 设备局域网IP
  "token": "YOUR_TOKEN",     // 通过 2.1 获取
  "cmd": "sendsms",          // 指令名称
  "params": {                // 指令参数
    "p1": "1",
    "p2": "10086",
    "p3": "cxll"
  }
}
```

#### 2.3 常用快捷指令
所有当前固件命令均可通过 `POST /api/control/:command` 调用，Body 中提供
`deviceIp`（也可用 `devId`）以及 `token`；也可以提供 `adminPassword` 让服务端计算 Token。
`GET /api/control/commands` 可获取完整命令清单和参数映射。

控制请求支持 `transport`：

- `auto`（默认）：设备存在TCP长连接时优先TCP，否则回退到HTTP `/ctrl`
- `tcp`：只允许通过开发板主动建立的TCP连接发送，TCP模式无需开发板token
- `http`：只允许服务器直连开发板HTTP接口，需要token或`adminPassword`

TCP模式应使用 `devId` 作为目标：

```json
POST /api/control/sendsms
{
  "devId": "498060912345",
  "transport": "tcp",
  "slot": 1,
  "phone": "10086",
  "content": "cxll",
  "tid": "sms-001"
}
```

`GET /api/control/connections` 可查看当前已注册的TCP设备连接。TCP数据以真实二进制
`0x11 0x12` 结尾；服务会处理半包/粘包，并在收到100/101/102联网消息后自动返回
`now`时间同步命令。

| 功能 | 接口路径 | 额外 Body 参数 | 说明 |
| :--- | :--- | :--- | :--- |
| **重启设备** | `/api/control/restart` | 无 | 立即重启设备 |
| **发送短信** | `/api/control/sendsms` | `slot` (1/2), `phone`, `content`, `tid` | `tid` 为事务ID，用于追踪结果 |
| **拨打电话** | `/api/control/teldial` | `slot`, `phone`, `duration` (秒), `tts` (内容) | 拨通后可播放 TTS 语音 |
| **挂断电话** | `/api/control/telhangup` | `slot` | 挂断当前通话 |
| **卡槽电源** | `/api/control/slotpwr` | `slot`, `action` (on/off) | 设置或查询卡槽电源 |
| **WiFi控制** | `/api/control/wf` | `action` (on/off/ap) | 设置或查询 WiFi 模式 |
| **每日重启** | `/api/control/dailyrst` | `hour` (0-23) | 设置每日自动重启时间 |

当前命令覆盖设备、卡槽、WiFi、短信、通话、TTS、录音、AMR 和 OTA，包括
`pingintvl`、`ackmax`、`readcard`、`writecard`、`querysms`、`querytel`、
`telstartrecord`、`telstoprecord`、`telrecordupload`、`uploadamrlist`、
`uploadamrremove`、`telamrplay`、`telamrstop`、`otanow` 等。

#### 2.4 上传 AMR 音频

通过 sms_web 将 multipart 请求原样代理给开发板（文件名必须以小写 `.amr` 结尾，
请求体不超过 101KB）：

```bash
curl -u admin:admin123 -F "file=@greeting.amr" \
  "http://localhost:3000/api/control/amr-upload?deviceIp=192.168.1.10"
```

#### 2.5 接收开发板通话录音

sms_web 提供独立的录音接收接口。先在 `.env` 设置强随机密钥：

```env
RECORDING_UPLOAD_KEY=replace-with-a-long-random-key
RECORDING_MAX_SIZE_MB=50
RECORDING_RETENTION_DAYS=0
```

然后在开发板后台将 `telRecUrl` 设置为（域名、端口和密钥按实际修改）：

```text
http://YOUR_SERVER:3000/recordings/upload?key=YOUR_KEY&devId={{devId}}&slot={{slot}}&phNum={{phNum}}&telStartTs={{telStartTs}}&telConnectedTs={{telConnectedTs}}&telEndTs={{telEndTs}}&tid={{tid}}
```

开发板以 `multipart/form-data` 上传，文件字段名固定为 `media`。sms_web 校验 AMR 文件头、保存文件和元数据，并返回开发板要求的 JSON：

```json
{
  "errcode": 0,
  "errmsg": "success",
  "type": "amr",
  "media_id": "1784000000000_abcd_call_01.amr",
  "created_at": 1784000000
}
```

开发板的接口消息设置还需启用 `695`（上传成功）和 `696`（上传失败），并继续将它们推送到 `/push`。sms_web 会用 `media_id` 或 `tid` 将通知和本地录音关联。

开始录音并在结束后立即上传：

```json
POST /api/control/telstartrecord
{
  "devId": "设备ID",
  "adminPassword": "开发板管理员密码",
  "slot": 1,
  "duration": 30,
  "filename": "call_01.amr",
  "upload": 1,
  "tid": "call-001"
}
```

录音管理接口均受管理端 Basic Auth 保护：

| 方法 | 路径 | 说明 |
|-----|------|------|
| GET | `/api/recordings` | 分页查询，可按 `devId`、`slot`、`phoneNum`、`status` 筛选 |
| GET | `/api/recordings/:id/download` | 下载或在线播放 AMR 文件 |
| DELETE | `/api/recordings/:id` | 删除录音记录及文件 |
| POST | `/api/recordings/batch-delete` | 批量删除录音记录及文件 |

### 3. 数据查询 API

用于获取系统存储的历史数据。

| 功能 | 接口路径 | 方法 | 参数 (Query) |
| :--- | :--- | :--- | :--- |
| **设备列表** | `/api/devices` | GET | 无 |
| **短信记录** | `/api/sms` | GET | `page`, `limit`, `devId`, `keyword` |
| **通话记录** | `/api/calls` | GET | `page`, `limit`, `type` (incoming/outgoing) |
| **通话录音** | `/api/recordings` | GET | `page`, `limit`, `devId`, `slot`, `phoneNum`, `status` |
| **系统日志** | `/api/messages` | GET | `page`, `limit` |

### 4. 开发板推送接口 (Webhook)

用于接收开发板上报的数据，需在开发板后台配置。

- **接口地址**: `http://YOUR_IP:3000/push`
- **方法**: `POST`
- **鉴权**: Header `X-API-Key` 或 Query `apiKey` (在 `.env` 中配置 `API_KEY`)

| 方法 | 路径 | 说明 |
|-----|------|------|
| POST | `/push` | 接收JSON格式推送 |
| POST | `/push-form` | 接收Form格式推送 |
| GET | `/push` | 接收GET方式推送 |

### 5. TCP反向控制配置

适用于开发板处于4G或NAT网络、服务器无法主动访问开发板IP的场景。开发板主动连接
sms_web，sms_web 再沿同一条长连接下发命令。

在开发板管理后台的“接口信息配置”中设置：

```text
接口地址: tcp://TCP公网域名或服务器公网IP:6888
接口消息: 至少启用 100/101/102、401、402、998
```

短信业务再启用501/502，通话业务启用601~623。TCP首条联网消息必须包含`devId`，
sms_web 会在5秒内返回14位北京时间完成握手。

HTTP入口可以继续使用 Cloudflare Tunnel；普通 Tunnel 的原生TCP客户端需要安装
`cloudflared access tcp`，开发板无法使用。因此6888端口应直接暴露，或使用支持原生
TCP的 Cloudflare Spectrum。不要把TCP域名配置成普通 Tunnel 公网主机名。

公网TCP建议在开发板中启用AES模式2（上下行双向加密），并在sms_web中配置相同参数：

```env
TCP_ENABLED=true
TCP_PORT=6888
AES_ENABLED=true
AES_MODE=2
AES_KEY=16字节密钥
AES_IV=16字节向量
```

### 管理接口

#### 设备管理

| 方法 | 路径 | 说明 |
|-----|------|------|
| GET | `/api/devices` | 获取设备列表 |
| GET | `/api/devices/:devId` | 获取设备详情 |
| PUT | `/api/devices/:devId` | 更新设备信息 |
| DELETE | `/api/devices/:devId` | 删除设备 |

#### 短信记录

| 方法 | 路径 | 说明 |
|-----|------|------|
| GET | `/api/sms` | 获取短信列表 |
| GET | `/api/sms/:devId` | 获取设备短信 |

查询参数：
- `devId` - 设备ID
- `phoneNum` - 号码（模糊搜索）
- `direction` - 方向 (in/out)
- `page` - 页码
- `limit` - 每页数量

#### 通话记录

| 方法 | 路径 | 说明 |
|-----|------|------|
| GET | `/api/calls` | 获取通话列表 |

查询参数：
- `devId` - 设备ID
- `phoneNum` - 号码（模糊搜索）
- `callType` - 类型 (incoming/outgoing/missed)
- `page` - 页码
- `limit` - 每页数量

#### 消息日志

| 方法 | 路径 | 说明 |
|-----|------|------|
| GET | `/api/messages` | 获取消息日志 |

#### 统计信息

| 方法 | 路径 | 说明 |
|-----|------|------|
| GET | `/api/stats` | 获取统计数据 |
| GET | `/api/message-types` | 获取消息类型定义 |

## 目录结构

```
lvyou-server/
├── src/
│   ├── app.js           # 主应用入口
│   ├── database.js      # 数据库初始化
│   ├── constants.js     # 常量定义
│   ├── messageHandler.js # 消息处理器
│   └── routes.js        # 管理API路由
├── public/
│   └── index.html       # Web管理界面
├── data/
│   └── lvyou.db         # SQLite数据库（自动创建）
├── package.json
└── README.md
```

## 数据存储

使用 SQLite 数据库，数据文件自动创建在 `data/lvyou.db`。

数据表：
- `devices` - 设备信息
- `sim_cards` - SIM卡信息
- `messages` - 消息日志
- `sms_records` - 短信记录
- `call_records` - 通话记录

## 环境变量

| 变量 | 默认值 | 说明 |
|-----|-------|------|
| PORT | 3000 | 服务端口 |

## 部署建议

### 使用 PM2 部署

```bash
npm install -g pm2
pm2 start src/app.js --name lvyou-server
pm2 save
pm2 startup
```

### 使用 Docker 部署

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "src/app.js"]
```

## 注意事项

1. 确保服务器端口（默认3000）对开发板可访问
2. 建议在生产环境使用反向代理（如 Nginx）
3. 定期备份 `data/lvyou.db` 数据库文件
4. 设备离线检测默认为5分钟无活动

## License

ISC
