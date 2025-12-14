const crypto = require('crypto');
const { decryptData } = require('./aesDecrypt');
const config = require('./config');

/**
 * 计算token (sha256(devId|adminName|adminPassword))
 * @param {string} devId - 设备ID
 * @param {string} adminName - 管理员用户名
 * @param {string} adminPassword - 管理员密码
 * @returns {string} 64位SHA256 token (大写)
 */
function calculateToken(devId, adminName, adminPassword) {
    const input = `${devId}|${adminName}|${adminPassword}`;
    return crypto.createHash('sha256').update(input).digest('hex').toUpperCase();
}

/**
 * 发送指令到设备
 * @param {string} deviceIp - 设备IP
 * @param {string} token - 认证token
 * @param {string} cmd - 命令名称
 * @param {object} params - 命令参数
 */
async function sendCommandToDevice(deviceIp, token, cmd, params = {}) {
    if (!deviceIp || !cmd) {
        throw new Error('缺少必要参数: deviceIp, cmd');
    }
    
    if (!token) {
        throw new Error('缺少必要参数: token');
    }
    
    // 构建URL参数
    const urlParams = new URLSearchParams();
    urlParams.append('token', token);
    urlParams.append('cmd', cmd);
    
    // 添加其他参数 (p1, p2, p3, tid等)
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
            urlParams.append(key, value);
        }
    }
    
    const url = `http://${deviceIp}/ctrl?${urlParams.toString()}`;
    console.log(`[Control] 发送控制指令: ${url}`);
    
    // 发送HTTP请求到设备
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    try {
        const response = await fetch(url, {
            method: 'GET',
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        const contentType = response.headers.get('content-type');
        let result;
        
        if (contentType && contentType.includes('application/json')) {
            result = await response.json();
        } else {
            result = await response.text();
            // 尝试解析为JSON
            try {
                result = JSON.parse(result);
            } catch (e) {
                result = { raw: result };
            }
        }
        
        // 如果启用了AES加密，尝试解密设备响应
        let decryptedResult = result;
        if (config.aes.enabled && result) {
            try {
                // 如果是对象，尝试解密
                if (typeof result === 'object' && result !== null) {
                    decryptedResult = decryptData(result, config.aes);
                    console.log(`[Control] 设备响应已解密:`, decryptedResult);
                } else if (typeof result === 'string') {
                    // 如果是字符串，可能是加密的Base64
                    try {
                        const temp = decryptData({ p: result }, config.aes);
                        decryptedResult = temp;
                        console.log(`[Control] 设备响应已解密:`, decryptedResult);
                    } catch (e) {
                        console.log(`[Control] 设备响应(未加密):`, result);
                        decryptedResult = result;
                    }
                }
            } catch (decryptError) {
                console.warn(`[Control] 解密设备响应失败:`, decryptError.message);
                console.log(`[Control] 设备响应(原始):`, result);
                decryptedResult = result;
            }
        } else {
            console.log(`[Control] 设备响应:`, result);
        }
        
        return {
            success: true,
            data: decryptedResult,
            command: { cmd, params, url }
        };
        
    } catch (fetchError) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
            throw new Error('设备请求超时，请检查设备IP是否正确，设备是否在线');
        }
        throw fetchError;
    }
}

module.exports = {
    calculateToken,
    sendCommandToDevice
};
