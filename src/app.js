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
    
    // 检查是否是排除的路径（开发板推送接口不需要鉴权）
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

// ==================== 开发板数据接收接口 ====================

/**
 * POST /push
 * 接收开发板推送的消息 (application/json 格式)
 * 
 * 开发板配置:
 * - 接口地址: http://your-server:3000/push
 * - HTTP请求方式: POST
 * - Content-Type: application/json
 */
app.post('/push', (req, res) => {
    console.log('[Push] 收到JSON推送:', req.body);
    
    try {
        // 如果启用了AES加密，先解密数据
        const data = decryptData(req.body, config.aes);
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
 * - 接口地址: http://your-server:3000/push-form
 * - HTTP请求方式: POST
 * - Content-Type: application/x-www-form-urlencoded
 */
app.post('/push-form', (req, res) => {
    console.log('[Push] 收到FORM推送:', req.body);
    
    try {
        // 如果启用了AES加密，先解密数据
        const decrypted = decryptData(req.body, config.aes);
        
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
 * - 接口地址: http://your-server:3000/push
 * - HTTP请求方式: GET
 */
app.get('/push', (req, res) => {
    console.log('[Push] 收到GET推送:', req.query);
    
    try {
        // GET + JSON 方式，数据在 p 参数中
        let data = req.query;
        if (req.query.p) {
            try {
                // 尝试 AES 解密 p 参数
                const decryptedP = tryDecrypt(req.query.p);
                data = typeof decryptedP === 'string' ? JSON.parse(decryptedP) : decryptedP;
            } catch (e) {
                // 不是JSON格式，使用原始query参数（也尝试解密）
                data = tryDecrypt(req.query);
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
        console.log('║  开发板配置说明:                                           ║');
        console.log('║  ┌────────────────────────────────────────────────────┐    ║');
        console.log(`║  │ 接口地址(JSON): http://你的服务器IP:${PORT}/push           │    ║`);
        console.log(`║  │ 接口地址(FORM): http://你的服务器IP:${PORT}/push-form      │    ║`);
        console.log('║  │ HTTP请求方式: POST                                 │    ║');
        console.log('║  │ Content-Type: application/json (推荐)              │    ║');
        console.log('║  └────────────────────────────────────────────────────┘    ║');
        console.log('║                                                            ║');
        console.log('║  管理界面: http://localhost:' + PORT + '                           ║');
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log('');
    });
}

startServer().catch(err => {
    console.error('启动失败:', err);
    process.exit(1);
});

module.exports = app;
