/**
 * IoT设备管理服务 - 主应用入口
 * 接收开发板推送的消息并提供管理API
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

const { initDatabase } = require('./database');
const messageHandler = require('./messageHandler');
const routes = require('./routes');
const config = require('./config');
const { decryptData, encryptData } = require('./aesDecrypt');
const recordingService = require('./recordingService');
const tcpGateway = require('./tcpGateway');

const app = express();
const PORT = config.port;

// ==================== 中间件配置 ====================

// 1. 基础中间件
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 开发板录音文件上传接口使用独立密钥，不受管理端 Basic Auth 影响。
app.post('/recordings/upload', recordingService.uploadAuth, recordingService.receiveUpload);

// 2. 静态文件服务 (公开访问，无需鉴权)
// 放在鉴权中间件之前，提高性能并避免鉴权逻辑干扰
app.use(express.static(path.join(__dirname, '../public')));

// ==================== 鉴权中间件定义 ====================

/**
 * 验证 API Key（用于开发板推送接口）
 */
function apiKeyAuth(req, res, next) {
    if (!config.apiKey.enabled) return next();
    
    const configuredKey = config.apiKey.key;
    let providedKey = req.headers['x-api-key'] || 
                      (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.substring(7) : null) ||
                      req.query.apiKey || 
                      (req.body && req.body.apiKey);
    
    if (!providedKey) {
        console.warn(`[Auth] API Key 缺失 - IP: ${req.ip}, Path: ${req.path}`);
        return res.status(401).json({ code: -1, error: 'API Key 缺失', message: '请提供有效的 API Key' });
    }
    
    if (providedKey !== configuredKey) {
        console.warn(`[Auth] API Key 无效 - IP: ${req.ip}, Path: ${req.path}`);
        return res.status(403).json({ code: -1, error: 'API Key 无效', message: 'API Key 验证失败' });
    }
    
    next();
}

/**
 * 验证HTTP Basic Auth (用于管理API)
 */
function basicAuth(req, res, next) {
    if (!config.auth.enabled) return next();
    
    // 检查排除路径 (保留配置兼容性)
    const excludePaths = config.auth.excludePaths || [];
    if (excludePaths.some(p => req.path === p || req.path.startsWith(p + '/'))) {
        return next();
    }
    
    let authHeader = req.headers.authorization || req.query._auth;
    
    if (!authHeader || !authHeader.startsWith('Basic ')) {
        return res.status(401).json({ error: '需要登录认证' });
    }
    
    const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf-8');
    const [username, password] = credentials.split(':');
    
    if (username === config.auth.username && password === config.auth.password) {
        return next();
    }
    
    return res.status(401).json({ error: '用户名或密码错误' });
}

// ==================== 辅助函数 ====================

function tryDecrypt(value) {
    if (!config.aes.enabled || !value) return value;
    try {
        return decryptData({ p: value }, config.aes);
    } catch (e) {
        return value;
    }
}

/**
 * 统一处理消息推送逻辑
 */
function normalizePushData(data, metadata = {}) {
    return {
        ...data,
        ...metadata,
        type: parseInt(data.type, 10),
        slot: (data.slot !== undefined && data.slot !== '') ? parseInt(data.slot, 10) : undefined,
        dbm: (data.dbm !== undefined && data.dbm !== '') ? parseInt(data.dbm, 10) : undefined,
        smsTs: data.smsTs ? parseInt(data.smsTs, 10) : undefined,
        telStartTs: data.telStartTs ? parseInt(data.telStartTs, 10) : undefined,
        telEndTs: data.telEndTs ? parseInt(data.telEndTs, 10) : undefined,
    };
}

function handlePushMessage(data, res) {
    try {
        messageHandler.handleMessage(normalizePushData(data, { _transport: 'http' }));
        res.json({ code: 0, message: 'OK' });
    } catch (error) {
        console.error('[Push] 处理消息失败:', error);
        res.status(500).json({ code: -1, message: error.message });
    }
}

// ==================== 路由定义 ====================

// --- 开发板推送接口 (使用 apiKeyAuth) ---

app.post('/push', apiKeyAuth, (req, res) => {
    console.log('[Push] 收到JSON推送:', req.body);
    try {
        const { apiKey, ...bodyData } = req.body;
        const data = decryptData(bodyData, config.aes);
        handlePushMessage(data, res);
    } catch (error) {
        console.error('[Push] 解密失败:', error);
        res.status(500).json({ code: -1, message: error.message });
    }
});

app.post('/push-form', apiKeyAuth, (req, res) => {
    console.log('[Push] 收到FORM推送:', req.body);
    try {
        const { apiKey, ...bodyData } = req.body;
        const data = decryptData(bodyData, config.aes);
        handlePushMessage(data, res);
    } catch (error) {
        console.error('[Push] 解密失败:', error);
        res.status(500).json({ code: -1, message: error.message });
    }
});

app.get('/push', apiKeyAuth, (req, res) => {
    console.log('[Push] 收到GET推送:', req.query);
    try {
        const { apiKey, ...queryData } = req.query;
        let data = queryData;
        
        if (queryData.p) {
            try {
                const decryptedP = tryDecrypt(queryData.p);
                data = typeof decryptedP === 'string' ? JSON.parse(decryptedP) : decryptedP;
            } catch (e) {
                data = tryDecrypt(queryData);
            }
        }
        handlePushMessage(data, res);
    } catch (error) {
        console.error('[Push] 处理失败:', error);
        res.status(500).json({ code: -1, message: error.message });
    }
});

// --- 管理API (使用 basicAuth) ---
// 直接挂载鉴权中间件到 /api 路径
app.use('/api/recordings', basicAuth, recordingService.router);
app.use('/api', basicAuth, routes);

// --- 兜底路由 (SPA支持) ---
// 所有未匹配的路由都返回 index.html，让前端路由处理
// Express 5 / path-to-regexp 8 要求通配符必须命名；花括号形式同时匹配根路径。
app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ==================== 启动服务 ====================
async function startServer() {
    // 初始化数据库
    await initDatabase();
    recordingService.cleanupExpired();

    if (config.tcp.enabled) {
        tcpGateway.configure({
            ...config.tcp,
            onMessage: async (rawMessage, connection) => {
                const decrypted = decryptData(rawMessage, config.aes);
                const parsed = normalizePushData(decrypted, {
                    _transport: 'tcp',
                    _remoteAddress: connection.remoteAddress
                });
                messageHandler.handleMessage(parsed);
                return parsed;
            },
            encodeMessage: message => encryptData(message, config.aes)
        });
        tcpGateway.on('connected', connection => {
            console.log(`[TCP] 设备已注册: ${connection.devId} (${connection.remoteAddress}:${connection.remotePort})`);
        });
        tcpGateway.on('disconnected', connection => {
            console.log(`[TCP] 设备已断开: ${connection.devId}`);
        });
        tcpGateway.on('clientError', (error, connection) => {
            console.warn(`[TCP] 客户端异常 ${connection.devId || connection.remoteAddress || 'unknown'}: ${error.message}`);
        });
        const tcpAddress = await tcpGateway.start();
        console.log(`[TCP] 反向控制网关已启动: ${tcpAddress.address}:${tcpAddress.port}`);
    }
    
    // 定时任务 - 每5分钟检查一次设备离线状态
    setInterval(() => {
        messageHandler.checkOfflineDevices(300);
    }, 5 * 60 * 1000);
    setInterval(() => recordingService.cleanupExpired(), 6 * 60 * 60 * 1000);
    
    app.listen(PORT, () => {
        console.log('');
        console.log('╔════════════════════════════════════════════════════════════╗');
        console.log('║       🔧 IoT设备管理服务已启动                             ║');
        console.log('╠════════════════════════════════════════════════════════════╣');
        console.log(`║  服务地址: http://localhost:${PORT}                           ║`);
        console.log('║                                                            ║');
        console.log('║  🔐 安全配置:                                              ║');
        console.log(`║  ├─ API Key 认证: ${config.apiKey.enabled ? '已启用' : '已禁用'}                               ║`);
        console.log(`║  └─ 管理界面认证: ${config.auth.enabled ? '已启用' : '已禁用'}                               ║`);
        console.log('║                                                            ║');
        console.log('║  开发板配置说明:                                           ║');
        console.log('║  ┌────────────────────────────────────────────────────┐    ║');
        console.log(`║  │ 接口地址(JSON): http://IP:${PORT}/push?apiKey=YOUR_KEY   │    ║`);
        console.log(`║  │ 接口地址(FORM): http://IP:${PORT}/push-form?apiKey=KEY   │    ║`);
        console.log('║  │ HTTP请求方式: POST                                 │    ║');
        console.log('║  │ Content-Type: application/json (推荐)              │    ║');
        console.log('║  └────────────────────────────────────────────────────┘    ║');
        console.log('║                                                            ║');
        console.log('║  管理界面: https://your-domain (需要登录)                  ║');
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log('');
    });
}

startServer().catch(err => {
    console.error('启动失败:', err);
    process.exit(1);
});

module.exports = app;
