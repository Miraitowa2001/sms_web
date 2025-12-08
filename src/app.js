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
const { decryptData } = require('./aesDecrypt');

const app = express();
const PORT = config.port;

// ==================== API Key 认证中间件 ====================

/**
 * 验证 API Key（用于开发板推送接口）
 * 支持多种传递方式：
 * 1. Header: X-API-Key: your-key
 * 2. Header: Authorization: Bearer your-key
 * 3. Query: ?apiKey=your-key
 * 4. Body: { apiKey: "your-key", ... }
 */
function apiKeyAuth(req, res, next) {
    // 检查是否启用 API Key 认证
    if (!config.apiKey.enabled) {
        return next();
    }
    
    const configuredKey = config.apiKey.key;
    
    // 从多个位置获取 API Key
    let providedKey = null;
    
    // 1. 从 Header 获取 (X-API-Key)
    if (req.headers['x-api-key']) {
        providedKey = req.headers['x-api-key'];
    }
    // 2. 从 Header 获取 (Authorization: Bearer xxx)
    else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        providedKey = req.headers.authorization.substring(7);
    }
    // 3. 从 Query 获取
    else if (req.query.apiKey) {
        providedKey = req.query.apiKey;
    }
    // 4. 从 Body 获取
    else if (req.body && req.body.apiKey) {
        providedKey = req.body.apiKey;
    }
    
    // 验证 API Key
    if (!providedKey) {
        console.warn(`[Auth] API Key 缺失 - IP: ${req.ip}, Path: ${req.path}`);
        return res.status(401).json({ 
            code: -1, 
            error: 'API Key 缺失',
            message: '请提供有效的 API Key'
        });
    }
    
    if (providedKey !== configuredKey) {
        console.warn(`[Auth] API Key 无效 - IP: ${req.ip}, Path: ${req.path}, Key: ${providedKey.substring(0, 8)}...`);
        return res.status(403).json({ 
            code: -1, 
            error: 'API Key 无效',
            message: 'API Key 验证失败'
        });
    }
    
    // 验证通过
    next();
}

// ==================== HTTP基本鉴权中间件 ====================

/**
 * 验证HTTP Basic Auth
 * 只对 API 路径进行鉴权，静态文件不需要鉴权
 */
function basicAuth(req, res, next) {
    // 检查是否启用鉴权
    if (!config.auth.enabled) {
        return next();
    }
    
    // 检查是否是排除的路径（开发板推送接口不需要 Basic Auth，由 API Key 单独验证）
    const excludePaths = config.auth.excludePaths || [];
    if (excludePaths.some(p => req.path === p || req.path.startsWith(p + '/'))) {
        return next();
    }
    
    // 静态文件不需要鉴权（让前端自己处理登录）
    // 只有 /api 开头的请求才需要鉴权
    if (!req.path.startsWith('/api')) {
        return next();
    }
    
    // 获取Authorization头
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Basic ')) {
        // 不设置 WWW-Authenticate 头，避免浏览器弹出原生认证框
        return res.status(401).json({ error: '需要登录认证' });
    }
    
    // 解码Base64凭证
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
    const [username, password] = credentials.split(':');
    
    // 验证用户名密码
    if (username === config.auth.username && password === config.auth.password) {
        return next();
    }
    
    // 不设置 WWW-Authenticate 头，避免浏览器弹出原生认证框
    return res.status(401).json({ error: '用户名或密码错误' });
}

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 对管理页面和API应用鉴权
app.use(basicAuth);

// 静态文件服务
app.use(express.static(path.join(__dirname, '../public')));

// ==================== AES 解密辅助函数 ====================

/**
 * 尝试解密单个字段
 */
function tryDecrypt(value) {
    if (!config.aes.enabled || !value) {
        return value;
    }
    try {
        return decryptData({ p: value }, config.aes);
    } catch (e) {
        return value;
    }
}

// ==================== 开发板数据接收接口 ====================

/**
 * POST /push
 * 接收开发板推送的消息 (application/json 格式)
 * 
 * 开发板配置:
 * - 接口地址: http://your-server:3000/push?apiKey=your-key
 * - HTTP请求方式: POST
 * - Content-Type: application/json
 * 
 * API Key 传递方式（任选一种）:
 * - Header: X-API-Key: your-key
 * - Header: Authorization: Bearer your-key
 * - Query: ?apiKey=your-key
 * - Body: { apiKey: "your-key", ... }
 */
app.post('/push', apiKeyAuth, (req, res) => {
    console.log('[Push] 收到JSON推送:', req.body);
    
    try {
        // 移除 body 中的 apiKey（如果有）
        const { apiKey, ...bodyData } = req.body;
        
        // 如果启用了AES加密，先解密数据
        const data = decryptData(bodyData, config.aes);
        const result = messageHandler.handleMessage(data);
        res.json({ code: 0, message: 'OK' });
    } catch (error) {
        console.error('[Push] 处理消息失败:', error);
        res.status(500).json({ code: -1, message: error.message });
    }
});

/**
 * POST /push-form
 * 接收开发板推送的消息 (application/x-www-form-urlencoded 格式)
 * 
 * 开发板配置:
 * - 接口地址: http://your-server:3000/push-form?apiKey=your-key
 * - HTTP请求方式: POST
 * - Content-Type: application/x-www-form-urlencoded
 */
app.post('/push-form', apiKeyAuth, (req, res) => {
    console.log('[Push] 收到FORM推送:', req.body);
    
    try {
        // 移除 body 中的 apiKey（如果有）
        const { apiKey, ...bodyData } = req.body;
        
        // 如果启用了AES加密，先解密数据
        const decrypted = decryptData(bodyData, config.aes);
        
        // 将表单数据转换为统一格式
        const data = {
            ...decrypted,
            type: parseInt(decrypted.type, 10),
            slot: decrypted.slot ? parseInt(decrypted.slot, 10) : undefined,
            dbm: decrypted.dbm ? parseInt(decrypted.dbm, 10) : undefined,
            smsTs: decrypted.smsTs ? parseInt(decrypted.smsTs, 10) : undefined,
            telStartTs: decrypted.telStartTs ? parseInt(decrypted.telStartTs, 10) : undefined,
            telEndTs: decrypted.telEndTs ? parseInt(decrypted.telEndTs, 10) : undefined,
        };
        
        const result = messageHandler.handleMessage(data);
        res.json({ code: 0, message: 'OK' });
    } catch (error) {
        console.error('[Push] 处理消息失败:', error);
        res.status(500).json({ code: -1, message: error.message });
    }
});

/**
 * GET /push
 * 接收开发板推送的消息 (GET方式)
 * 
 * 开发板配置:
 * - 接口地址: http://your-server:3000/push?apiKey=your-key
 * - HTTP请求方式: GET
 */
app.get('/push', apiKeyAuth, (req, res) => {
    console.log('[Push] 收到GET推送:', req.query);
    
    try {
        // 移除 query 中的 apiKey
        const { apiKey, ...queryData } = req.query;
        
        // GET + JSON 方式，数据在 p 参数中
        let data = queryData;
        if (queryData.p) {
            try {
                // 尝试 AES 解密 p 参数
                const decryptedP = tryDecrypt(queryData.p);
                data = typeof decryptedP === 'string' ? JSON.parse(decryptedP) : decryptedP;
            } catch (e) {
                // 不是JSON格式，使用原始query参数（也尝试解密）
                data = tryDecrypt(queryData);
            }
        }
        
        // 转换数据类型
        const parsedData = {
            ...data,
            type: parseInt(data.type, 10),
            slot: data.slot ? parseInt(data.slot, 10) : undefined,
            dbm: data.dbm ? parseInt(data.dbm, 10) : undefined,
        };
        
        const result = messageHandler.handleMessage(parsedData);
        res.json({ code: 0, message: 'OK' });
    } catch (error) {
        console.error('[Push] 处理消息失败:', error);
        res.status(500).json({ code: -1, message: error.message });
    }
});

// ==================== 管理API路由 ====================
app.use('/api', routes);

// ==================== 首页重定向 ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ==================== 启动服务 ====================
async function startServer() {
    // 初始化数据库
    await initDatabase();
    
    // 定时任务 - 每5分钟检查一次设备离线状态
    setInterval(() => {
        messageHandler.checkOfflineDevices(300);
    }, 5 * 60 * 1000);
    
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
