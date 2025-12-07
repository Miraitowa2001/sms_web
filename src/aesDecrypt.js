/**
 * AES 解密模块
 * 用于解密开发板上报的加密数据
 * 
 * 开发板支持的加密算法: AES128 CBC pkcs#7 padding
 * 
 * 配置说明:
 * 在 config.js 中配置 aes.enabled = true 并设置 key 和 iv
 */

const crypto = require('crypto');

/**
 * 解析 KEY/IV 配置
 * 支持三种格式:
 * 1. ASCII字符串: "1234567890123456"
 * 2. 十进制数组: "49,50,51,52,53,54,55,56,57,48,49,50,51,52,53,54"
 * 3. 十六进制数组: "0x31,0x32,0x33,0x34,0x35,0x36,0x37,0x38,0x39,0x30,0x31,0x32,0x33,0x34,0x35,0x36"
 * 
 * @param {string} input - 配置字符串
 * @returns {Buffer} 16字节的Buffer
 */
function parseKeyOrIv(input) {
    if (!input) {
        throw new Error('AES KEY/IV 不能为空');
    }
    
    // 检查是否是逗号分隔的数字格式
    if (input.includes(',')) {
        const parts = input.split(',').map(p => p.trim());
        const bytes = parts.map(p => {
            if (p.startsWith('0x') || p.startsWith('0X')) {
                // 十六进制格式
                return parseInt(p, 16);
            } else {
                // 十进制格式
                return parseInt(p, 10);
            }
        });
        
        if (bytes.length !== 16) {
            throw new Error(`AES KEY/IV 必须是16字节，当前是 ${bytes.length} 字节`);
        }
        
        return Buffer.from(bytes);
    }
    
    // ASCII字符串格式
    if (input.length !== 16) {
        throw new Error(`AES KEY/IV 必须是16字节，当前是 ${input.length} 字节`);
    }
    
    return Buffer.from(input, 'utf-8');
}

/**
 * AES-128-CBC 解密
 * @param {string} encryptedBase64 - Base64编码的加密数据
 * @param {Buffer} key - 16字节密钥
 * @param {Buffer} iv - 16字节初始化向量
 * @returns {string} 解密后的明文
 */
function aesDecrypt(encryptedBase64, key, iv) {
    try {
        // Base64 URL Safe 转换为标准 Base64
        let base64 = encryptedBase64
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        
        // 补齐Base64填充
        while (base64.length % 4 !== 0) {
            base64 += '=';
        }
        
        const encrypted = Buffer.from(base64, 'base64');
        const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
        decipher.setAutoPadding(true); // PKCS#7 padding
        
        let decrypted = decipher.update(encrypted);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        
        return decrypted.toString('utf-8');
    } catch (error) {
        throw new Error(`AES解密失败: ${error.message}`);
    }
}

/**
 * 解密开发板上报的数据
 * @param {object} data - 原始请求数据
 * @param {object} aesConfig - AES配置 { enabled, key, iv }
 * @returns {object} 解密后的数据对象
 */
function decryptData(data, aesConfig) {
    if (!aesConfig || !aesConfig.enabled) {
        // 未启用加密，直接返回原数据
        return data;
    }
    
    const key = parseKeyOrIv(aesConfig.key);
    const iv = parseKeyOrIv(aesConfig.iv);
    
    // HTTP POST + JSON 或 TCP 格式: { "p": "加密的Base64字符串" }
    if (data.p && typeof data.p === 'string') {
        const decryptedJson = aesDecrypt(data.p, key, iv);
        console.log('[AES] 解密JSON数据:', decryptedJson);
        return JSON.parse(decryptedJson);
    }
    
    // HTTP GET/POST + FORM 格式: 每个参数值单独加密
    const decryptedData = {};
    for (const [paramName, paramValue] of Object.entries(data)) {
        if (typeof paramValue === 'string' && paramValue.length > 0) {
            try {
                const decryptedValue = aesDecrypt(paramValue, key, iv);
                // 尝试解析为数字
                if (/^\d+$/.test(decryptedValue)) {
                    decryptedData[paramName] = parseInt(decryptedValue, 10);
                } else {
                    decryptedData[paramName] = decryptedValue;
                }
            } catch (e) {
                // 解密失败，可能是未加密的字段，保持原值
                decryptedData[paramName] = paramValue;
            }
        } else {
            decryptedData[paramName] = paramValue;
        }
    }
    
    console.log('[AES] 解密FORM数据:', decryptedData);
    return decryptedData;
}

module.exports = {
    parseKeyOrIv,
    aesDecrypt,
    decryptData
};
