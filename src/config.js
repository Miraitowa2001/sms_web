/**
 * 服务器配置文件
 * 用于配置服务器鉴权、AES加密和其他设置
 * 
 * 敏感配置请通过环境变量或 .env 文件设置
 * 参考 .env.example 文件
 */

// 加载 .env 文件（如果存在）
try {
    require('dotenv').config();
} catch (e) {
    // dotenv 未安装时忽略
}

const config = {
    // 服务器端口
    port: process.env.PORT || 3000,
    
    // HTTP鉴权配置（管理界面）
    auth: {
        enabled: process.env.AUTH_ENABLED !== 'false',  // 默认启用鉴权
        username: process.env.AUTH_USERNAME || 'admin',  // 管理员用户名
        password: process.env.AUTH_PASSWORD || 'admin123',  // 管理员密码（生产环境请务必修改）
        // 不需要鉴权的路径（开发板推送数据的接口由 apiKey 单独验证）
        excludePaths: ['/push', '/push-form']
    },
    
    // API Key 认证配置（开发板推送接口）
    apiKey: {
        enabled: process.env.API_KEY_ENABLED !== 'false',  // 默认启用
        key: process.env.API_KEY || 'your-secure-api-key-here',  // 生产环境请务必修改
        // 支持的传递方式: header, query, body
        // header: X-API-Key 或 Authorization: Bearer <key>
        // query: ?apiKey=xxx
        // body: { apiKey: "xxx", ... }
    },
    
    // AES加密配置（用于解密开发板上报的加密数据）
    // 开发板加密算法: AES128 CBC pkcs#7 padding
    aes: {
        enabled: process.env.AES_ENABLED === 'true',  // 默认关闭，需要时在 .env 中开启
        
        // KEY 和 IV 支持三种格式:
        // 1. ASCII字符串: "1234567890123456" (必须16字节)
        // 2. 十进制数组: "49,50,51,52,53,54,55,56,57,48,49,50,51,52,53,54"
        // 3. 十六进制数组: "0x31,0x32,0x33,0x34,0x35,0x36,0x37,0x38,0x39,0x30,0x31,0x32,0x33,0x34,0x35,0x36"
        key: process.env.AES_KEY || '1234567890123456',  // 16字节密钥（请在 .env 中配置实际值）
        iv: process.env.AES_IV || '1234567890123456'     // 16字节初始化向量（请在 .env 中配置实际值）
    },

    // 日志配置
    log: {
        // 是否保存原始消息到数据库 (messages表)
        // 建议关闭以节省空间，除非需要调试
        // 默认开启，除非环境变量显式设置为 false
        saveRawMessages: process.env.LOG_RAW_MESSAGES !== 'false',
        
        // 自动清理旧日志的天数 (0表示不清理)
        retentionDays: parseInt(process.env.LOG_RETENTION_DAYS || '7')
    },
    
    // 开发板控制指令配置
    deviceControl: {
        // 请求超时时间（毫秒）
        timeout: 10000
    }
};

module.exports = config;
