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

## 快速开始

### 1. 安装依赖

```bash
cd lvyou-server
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

- **接口地址**: `http://你的服务器IP:3000/push`
- **HTTP请求方式**: `POST`
- **Content-Type**: `application/json`（推荐）

如果使用 Form 格式：
- **接口地址**: `http://你的服务器IP:3000/push-form`
- **Content-Type**: `application/x-www-form-urlencoded`

### 4. 访问管理界面

打开浏览器访问: `http://localhost:3000`

## API 文档

### 数据接收接口

| 方法 | 路径 | 说明 |
|-----|------|------|
| POST | `/push` | 接收JSON格式推送 |
| POST | `/push-form` | 接收Form格式推送 |
| GET | `/push` | 接收GET方式推送 |

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
