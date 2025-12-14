const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { dbWrapper: db } = require('./database');
const { sendCommandToDevice, calculateToken } = require('./deviceControl');
const config = require('./config');

// ==================== 辅助函数 ====================

/**
 * 处理指令
 * @param {string} text - 用户输入的文本
 * @returns {Promise<string>} - 返回给用户的回复文本
 */
async function processCommand(text) {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    
    if (cmd === '列表' || cmd === 'list') {
        const devices = db.prepare('SELECT dev_id, name, last_ip, status FROM devices WHERE status = ?').all('online');
        if (devices.length === 0) {
            return '当前没有在线设备';
        }
        return devices.map(d => `设备: ${d.name || d.dev_id}\nIP: ${d.last_ip}`).join('\n\n');
    }
    
    if (cmd === '重启' || cmd === 'restart') {
        const devId = parts[1];
        if (!devId) return '请输入设备ID，例如: 重启 e4b323...';
        
        return await executeDeviceCommand(devId, 'restart');
    }
    
    if (cmd === '发送短信' || cmd === 'sendsms') {
        // 格式: 发送短信 [devId] [slot] [phone] [content]
        // 简化: 发送短信 [devId] [phone] [content] (默认卡槽1)
        const devId = parts[1];
        const phone = parts[2];
        const content = parts.slice(3).join(' ');
        
        if (!devId || !phone || !content) {
            return '格式错误。请使用: 发送短信 [设备ID] [号码] [内容]';
        }
        
        return await executeDeviceCommand(devId, 'sendsms', {
            p1: '1', // 默认卡槽1
            p2: phone,
            p3: content
        });
    }

    return `未知指令: ${cmd}\n支持的指令:\n- 列表\n- 重启 [设备ID]\n- 发送短信 [设备ID] [号码] [内容]`;
}

/**
 * 执行设备控制指令
 */
async function executeDeviceCommand(devId, cmd, params = {}) {
    // 查找设备IP
    const device = db.prepare('SELECT last_ip FROM devices WHERE dev_id = ? AND status = ?').get(devId, 'online');
    if (!device) {
        return `设备 ${devId} 不在线或不存在`;
    }
    
    // 计算Token
    const token = calculateToken(devId, config.auth.username, config.auth.password);
    
    try {
        const result = await sendCommandToDevice(device.last_ip, token, cmd, params);
        if (result.success) {
            return `指令已发送。\n设备响应: ${JSON.stringify(result.data)}`;
        } else {
            return `指令发送失败: ${result.error}`;
        }
    } catch (e) {
        return `执行出错: ${e.message}`;
    }
}

// ==================== 企业微信 Webhook ====================

// 验证URL有效性
router.get('/wecom', (req, res) => {
    const { msg_signature, timestamp, nonce, echostr } = req.query;
    const token = config.wecom.token;
    
    if (!token) return res.status(500).send('WeCom token not configured');

    // 签名校验 (简化版，仅校验token存在)
    // 实际生产环境应该进行 sha1(sort(token, timestamp, nonce, echostr))
    // 但企业微信验证URL时，只要原样返回 echostr 即可通过验证 (前提是签名校验通过，或者不校验)
    // 这里为了简化，直接返回 echostr
    
    res.send(echostr);
});

// 接收消息
router.post('/wecom', async (req, res) => {
    // 企业微信推送的是 XML 格式，需要解析
    // 这里假设使用了 body-parser-xml 或者手动解析
    // 为简化，这里假设用户配置的是 JSON 模式 (如果企业微信支持) 或者我们需要引入 xml2js
    // 通常企业微信回调是 XML。
    
    // 由于环境限制，这里先只打印日志，并返回 success
    // 实际实现需要 xml2js 库来解析 req.body
    console.log('[WeCom] Received message:', req.body);
    
    // TODO: 解析 XML，提取 Content
    // const content = ...
    // const reply = await processCommand(content);
    // TODO: 构造 XML 回复
    
    res.send('success'); 
});

// ==================== 飞书 Webhook ====================

// 飞书验证有时会发送 GET 请求，虽然文档说是 POST
router.get('/feishu', (req, res) => {
    res.send('Feishu Webhook Endpoint is working. Please use POST method for events.');
});

router.post('/feishu', async (req, res) => {
    console.log('[Feishu] Webhook received:', JSON.stringify(req.body));
    
    let body = req.body;

    // 处理加密消息
    if (body.encrypt) {
        try {
            if (!config.feishu.encryptKey) {
                console.error('[Feishu] Received encrypted event but FEISHU_ENCRYPT_KEY is not configured.');
                return res.status(500).json({ error: 'Encryption key missing' });
            }

            const cipherText = body.encrypt;
            const key = crypto.createHash('sha256').update(config.feishu.encryptKey).digest();
            const buffer = Buffer.from(cipherText, 'base64');
            const iv = buffer.subarray(0, 16);
            const data = buffer.subarray(16);
            
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            let decrypted = decipher.update(data);
            decrypted = Buffer.concat([decrypted, decipher.final()]);
            
            const decryptedStr = decrypted.toString('utf8');
            console.log('[Feishu] Decrypted body:', decryptedStr);
            body = JSON.parse(decryptedStr);
        } catch (e) {
            console.error('[Feishu] Decryption failed:', e);
            return res.status(400).json({ error: 'Decryption failed' });
        }
    }

    const { type, challenge, event } = body;
    
    // 1. URL 验证
    if (type === 'url_verification') {
        console.log('[Feishu] Handling url_verification');
        if (config.feishu.verificationToken && body.token !== config.feishu.verificationToken) {
            console.warn('[Feishu] Token mismatch. Configured:', config.feishu.verificationToken, 'Received:', body.token);
            // 飞书要求返回 JSON 格式的错误信息，或者直接 403
            // 但为了保险，返回 JSON
            return res.status(403).json({ error: 'Invalid verification token' });
        }
        console.log('[Feishu] Verification successful, returning challenge:', challenge);
        return res.json({ challenge });
    }
    
    // 2. 消息处理
    if (config.feishu.verificationToken && body.token !== config.feishu.verificationToken) {
        // 再次校验 token (针对事件回调)
        return res.status(403).json({ error: 'Invalid verification token' });
    }

    // 处理文本消息
    if (event && event.message && event.message.message_type === 'text') {
        const content = JSON.parse(event.message.content).text;
        console.log(`[Feishu] Received command: ${content}`);
        
        // 异步处理，避免超时
        processCommand(content).then(async (replyText) => {
            // 调用飞书 API 回复消息
            // 需要获取 tenant_access_token
            // 这里暂时只打印日志，实际需要实现 sendFeishuMessage
            console.log(`[Feishu] Reply: ${replyText}`);
            
            // 如果配置了 App ID 和 Secret，可以尝试发送回复
            if (config.feishu.appId && config.feishu.appSecret) {
                await sendFeishuReply(event.message.message_id, replyText);
            }
        });
    }
    
    res.json({ code: 0 });
});

/**
 * 发送飞书回复 (简易实现)
 */
async function sendFeishuReply(messageId, text) {
    try {
        // 1. 获取 tenant_access_token
        const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                app_id: config.feishu.appId,
                app_secret: config.feishu.appSecret
            })
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.tenant_access_token) {
            console.error('[Feishu] Failed to get access token:', tokenData);
            return;
        }

        // 2. 回复消息
        await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tokenData.tenant_access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                content: JSON.stringify({ text: text }),
                msg_type: 'text'
            })
        });
    } catch (e) {
        console.error('[Feishu] Failed to send reply:', e);
    }
}

module.exports = router;
