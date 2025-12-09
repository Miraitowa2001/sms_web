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

*   **端口冲突**：默认映射端口为 `36001`。如果被占用，请修改 `docker-compose.yml` 中的 `ports` 部分，例如映射到 8080 端口：`"8080:3000"`。
*   **权限问题**：在 Linux 环境下，如果遇到数据库写入权限错误，请确保宿主机的 `data` 目录具有写入权限。
