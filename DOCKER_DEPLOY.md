# Docker 部署指南

本项目支持使用 Docker 和 Docker Compose 进行轻量化部署。通过挂载外部数据目录和配置文件，确保了数据的持久化和配置的灵活性。

## 1. 环境要求

- [Docker](https://www.docker.com/get-started)
- [Docker Compose](https://docs.docker.com/compose/install/)

## 2. 部署步骤

### 2.1 准备配置文件

在项目根目录下，复制示例配置文件并重命名为 `.env`：

```bash
cp .env.example .env
# 或者在 Windows PowerShell 中:
# Copy-Item .env.example .env
```

使用文本编辑器打开 `.env` 文件，根据您的需求修改配置（如管理员密码、API Key 等）。

### 2.2 启动服务

在项目根目录下运行以下命令构建并启动容器：

```bash
docker-compose up -d --build
```

等待片刻，服务启动后即可通过浏览器访问：`http://localhost:36001` (或您服务器的 IP)。

默认端口：

| 宿主机端口 | 协议 | 用途 |
|---|---|---|
| 36001 | HTTP | 管理界面、REST API、开发板HTTP上报 |
| 6888 | 原生TCP | 开发板长连接上报和反向控制 |

### 2.3 Cloudflare Tunnel 部署说明

现有HTTP公网域名可以继续通过 Cloudflare Tunnel 指向：

```text
http://localhost:36001
```

开发板HTTP配置示例：

```text
https://sms.example.com/push
```

原生TCP不能直接使用普通 Tunnel 公网主机名，因为这种方式要求连接端安装
`cloudflared access tcp`。开发板TCP配置应使用以下方式之一：

1. 服务器公网IP或仅DNS解析（Cloudflare 灰云）的独立域名，并在云安全组及系统防火墙开放TCP 6888；
2. Cloudflare Spectrum 原生TCP代理。

推荐为TCP使用独立域名，例如：

```text
tcp-sms.example.com -> 服务器公网IP（DNS only/灰云）
```

开发板中填写：

```text
tcp://tcp-sms.example.com:6888
```

不要将 `tcp-sms.example.com` CNAME 到普通 Tunnel 的 `cfargotunnel.com` 地址。

## 3. 数据持久化与配置热更新

本项目采用了**外部挂载**的方式来管理数据和配置，这意味着您可以在不进入容器的情况下管理它们。

### 3.1 数据持久化 (`/data`)

*   **机制**：容器内的 `/app/data` 目录被映射到了宿主机的 `./data` 目录。
*   **作用**：所有的数据库文件（`lvyou.db`）都存储在您宿主机的 `data` 文件夹中。
*   **优势**：即使您删除了容器或重新构建了镜像，您的设备列表、短信记录等数据**不会丢失**。

### 3.2 配置热更新 (`.env`)

*   **机制**：宿主机的 `.env` 文件被直接挂载到容器中。
*   **如何更新配置**：
    1. 修改宿主机的 `.env` 文件。
    2. 运行 `docker-compose restart` 重启容器。
    3. 新配置立即生效，无需重新构建镜像。

## 4. 常用维护命令

### 查看运行状态
```bash
docker-compose ps
```

### 查看服务日志
```bash
docker-compose logs -f
```

### 重启服务 (修改配置后)
```bash
docker-compose restart
```

### 停止服务
```bash
docker-compose down
```

### 更新代码并重新部署
如果您更新了 `src` 目录下的代码，请运行：
```bash
docker-compose up -d --build
```

## 5. 故障排查

*   **端口冲突**：默认映射端口为HTTP `36001` 和TCP `6888`。如被占用，请同时修改 `docker-compose.yml` 和开发板接口地址。
*   **TCP无连接**：检查云安全组、宿主机防火墙、Docker端口映射以及域名是否为DNS only；普通 Cloudflare Tunnel 主机名不能供开发板直接连接原生TCP。
*   **TCP连接后立即断开**：检查服务是否在5秒内返回`now`握手、消息是否以二进制`0x11 0x12`结尾，以及AES模式/KEY/IV是否与开发板一致。
*   **权限问题**：在 Linux 环境下，如果遇到数据库写入权限错误，请确保宿主机的 `data` 目录具有写入权限。
