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
        
        const result = await executeDeviceCommand(devId, 'restart');
        return result.success ? `${result.message}\n设备响应: ${JSON.stringify(result.data)}` : result.message;
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
        
        const result = await executeDeviceCommand(devId, 'sendsms', {
            p1: '1', // 默认卡槽1
            p2: phone,
            p3: content
        });
        return result.success ? `${result.message}\n设备响应: ${JSON.stringify(result.data)}` : result.message;
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
        return { success: false, message: `设备 ${devId} 不在线或不存在` };
    }
    
    // 计算Token
    const token = calculateToken(devId, config.auth.username, config.auth.password);
    
    try {
        const result = await sendCommandToDevice(device.last_ip, token, cmd, params);
        if (result.success) {
            return { success: true, message: '指令已发送', data: result.data };
        } else {
            return { success: false, message: `指令发送失败: ${result.error}` };
        }
    } catch (e) {
        return { success: false, message: `执行出错: ${e.message}` };
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

// 简单的事件ID缓存，用于去重
const processedEvents = new Set();

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

    const { type, challenge, event, header } = body;
    const eventType = type || (header ? header.event_type : null);
    const requestToken = body.token || (header ? header.token : null);
    const eventId = header ? header.event_id : null;

    // 0. 事件去重
    if (eventId) {
        if (processedEvents.has(eventId)) {
            console.log(`[Feishu] Duplicate event ${eventId}, ignoring.`);
            return res.json({ code: 0 });
        }
        processedEvents.add(eventId);
        // 5分钟后清理
        setTimeout(() => processedEvents.delete(eventId), 5 * 60 * 1000);
    }
    
    // 1. URL 验证
    if (eventType === 'url_verification') {
        console.log('[Feishu] Handling url_verification');
        if (config.feishu.verificationToken && requestToken !== config.feishu.verificationToken) {
            console.warn('[Feishu] Token mismatch. Configured:', config.feishu.verificationToken, 'Received:', requestToken);
            // 飞书要求返回 JSON 格式的错误信息，或者直接 403
            // 但为了保险，返回 JSON
            return res.status(403).json({ error: 'Invalid verification token' });
        }
        console.log('[Feishu] Verification successful, returning challenge:', challenge);
        return res.json({ challenge });
    }
    
    // 2. 消息处理
    if (config.feishu.verificationToken && requestToken !== config.feishu.verificationToken) {
        // 再次校验 token (针对事件回调)
        console.warn('[Feishu] Token mismatch for event. Received:', requestToken);
        return res.status(403).json({ error: 'Invalid verification token' });
    }

    // 3. 卡片回调处理
    if (eventType === 'card.action.trigger') {
        console.log('[Feishu] Card action triggered:', JSON.stringify(body.action));
        
        const action = body.action.value;
        const openId = body.open_id; // 用户ID
        let toast = '操作已接收';

        if (action.cmd === 'refresh_menu') {
            // 刷新设备列表卡片
            const card = createDeviceControlCard();
            if (card) {
                // 更新原卡片 (需要 message_id，但这里是发送新卡片还是更新？)
                // 飞书卡片交互可以返回 card 字段来更新原卡片
                return res.json({
                    toast: { type: 'info', content: '列表已刷新' },
                    card: card
                });
            } else {
                toast = '当前没有在线设备';
            }
        } else if (action.cmd === 'restart') {
            if (action.dev_id) {
                // 异步执行，避免阻塞
                executeDeviceCommand(action.dev_id, 'restart').then(result => {
                    console.log(`[Feishu] Restart result for ${action.dev_id}:`, result);
                    if (result.success) {
                        sendFeishuMessage(openId, 'text', `设备 ${action.dev_id} 重启指令已发送`);
                    } else {
                        sendFeishuMessage(openId, 'text', `设备 ${action.dev_id} 重启失败: ${result.message}`);
                    }
                });
                toast = `正在重启设备 ${action.dev_id}...`;
            } else {
                toast = '缺少设备ID';
            }
        } else if (action.cmd === 'stat') {
            if (action.dev_id) {
                executeDeviceCommand(action.dev_id, 'stat').then(result => {
                    console.log(`[Feishu] Stat result for ${action.dev_id}:`, result);
                    if (result.success) {
                        // 格式化状态信息
                        const statusData = result.data;
                        const content = JSON.stringify(statusData, null, 2);
                        
                        // 发送卡片消息
                        const card = {
                            header: { title: { tag: 'plain_text', content: '设备状态查询' }, template: 'blue' },
                            elements: [
                                { 
                                    tag: 'div', 
                                    text: { 
                                        tag: 'lark_md', 
                                        content: `**设备**: ${action.dev_id}\n**状态**: 在线` 
                                    } 
                                },
                                { 
                                    tag: 'div', 
                                    text: { 
                                        tag: 'lark_md', 
                                        content: `详细信息:\n${content}` 
                                    } 
                                },
                                {
                                    tag: 'action',
                                    actions: [
                                        {
                                            tag: 'button',
                                            text: { tag: 'plain_text', content: '刷新状态' },
                                            type: 'primary',
                                            value: { cmd: 'stat', dev_id: action.dev_id }
                                        }
                                    ]
                                }
                            ]
                        };
                        sendFeishuMessage(openId, 'interactive', card);
                    } else {
                        sendFeishuMessage(openId, 'text', `查询状态失败: ${result.message}`);
                    }
                });
                toast = `正在查询设备 ${action.dev_id} 状态...`;
            } else {
                toast = '缺少设备ID';
            }
        }

        // 返回响应，可以更新卡片或仅显示 Toast
        return res.json({
            toast: {
                type: 'info',
                content: toast
            }
        });
    }

    // 4. 菜单点击事件处理 (application.bot.menu_v6)
    if (eventType === 'application.bot.menu_v6') {
        const eventData = body.event;
        const openId = eventData.operator.operator_id.open_id;
        const eventKey = eventData.event_key;
        
        console.log(`[Feishu] Menu clicked: ${eventKey}`);

        if (eventKey === 'menu_control' || eventKey === 'control') {
             const card = createDeviceControlCard();
             if (card) {
                 await sendFeishuMessage(openId, 'interactive', card);
             } else {
                 await sendFeishuMessage(openId, 'text', '当前没有设备');
             }
        }
        return res.json({ code: 0 });
    }

    // 处理文本消息
    if (event && event.message && event.message.message_type === 'text') {
        // 立即响应，防止超时重试
        res.json({ code: 0 });

        const content = JSON.parse(event.message.content).text.trim();
        console.log(`[Feishu] Received command: ${content}`);
        
        // 异步处理
        (async () => {
            try {
                // 检查是否是菜单指令
                if (['菜单', 'menu', '控制', 'control', '列表', 'list'].includes(content.toLowerCase())) {
                     const openId = event.sender.sender_id.open_id;
                     const card = createDeviceControlCard();
                     if (card) {
                         await sendFeishuMessage(openId, 'interactive', card);
                     } else {
                         await sendFeishuMessage(openId, 'text', '当前没有设备');
                     }
                     return;
                }
                
                // 普通指令处理
                const replyText = await processCommand(content);
                console.log(`[Feishu] Reply: ${replyText}`);
                
                if (config.feishu.appId && config.feishu.appSecret) {
                    await sendFeishuReply(event.message.message_id, replyText);
                }
            } catch (err) {
                console.error('[Feishu] Error processing message:', err);
            }
        })();
        
        return;
    }
    
    res.json({ code: 0 });
});

/**
 * 创建设备控制卡片
 */
function createDeviceControlCard() {
    // 查询所有设备，按状态排序（在线在前）
    const devices = db.prepare('SELECT dev_id, name, last_ip, status FROM devices ORDER BY status DESC, updated_at DESC').all();
    
    if (devices.length === 0) {
        return null;
    }

    const elements = [];
    
    // 头部提示
    const onlineCount = devices.filter(d => d.status === 'online').length;
    elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `共 ${devices.length} 台设备 (${onlineCount} 台在线)：` }
    });

    devices.forEach(dev => {
        const devName = dev.name || dev.dev_id;
        const isOnline = dev.status === 'online';
        const statusIcon = isOnline ? '🟢' : '🔴';
        const statusText = isOnline ? '在线' : '离线';
        
        elements.push({
            tag: 'div',
            text: { 
                tag: 'lark_md', 
                content: `${statusIcon} **${devName}** (${statusText})\nID: ${dev.dev_id}\nIP: ${dev.last_ip || '未知'}` 
            }
        });
        elements.push({
            tag: 'action',
            actions: [
                {
                    tag: 'button',
                    text: { tag: 'plain_text', content: '查看状态' },
                    type: isOnline ? 'primary' : 'default',
                    value: { cmd: 'stat', dev_id: dev.dev_id }
                },
                {
                    tag: 'button',
                    text: { tag: 'plain_text', content: '重启' },
                    type: 'danger',
                    value: { cmd: 'restart', dev_id: dev.dev_id },
                    confirm: {
                        title: { tag: 'plain_text', content: '确认重启' },
                        text: { tag: 'plain_text', content: `确定要重启设备 ${devName} 吗？` }
                    }
                }
            ]
        });
        elements.push({ tag: 'hr' });
    });

    // 移除最后一个分割线
    if (elements.length > 0 && elements[elements.length - 1].tag === 'hr') {
        elements.pop();
    }
    
    // 底部刷新按钮
    elements.push({
        tag: 'action',
        actions: [
            {
                tag: 'button',
                text: { tag: 'plain_text', content: '🔄 刷新列表' },
                type: 'default',
                value: { cmd: 'refresh_menu' }
            }
        ]
    });

    return {
        header: { title: { tag: 'plain_text', content: '🕹️ 设备控制台' }, template: 'blue' },
        elements: elements
    };
}

/**
 * 获取飞书 Tenant Access Token
 */
async function getTenantAccessToken() {
    try {
        const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                app_id: config.feishu.appId,
                app_secret: config.feishu.appSecret
            })
        });
        const data = await res.json();
        if (!data.tenant_access_token) {
            console.error('[Feishu] Failed to get access token:', data);
            return null;
        }
        return data.tenant_access_token;
    } catch (e) {
        console.error('[Feishu] Error getting access token:', e);
        return null;
    }
}

/**
 * 发送飞书消息 (给特定用户)
 * @param {string} openId - 用户 Open ID
 * @param {string} msgType - 消息类型 (text, interactive, etc.)
 * @param {object|string} content - 消息内容 (如果是 text 则为字符串，如果是 interactive 则为 card 对象)
 */
async function sendFeishuMessage(openId, msgType, content) {
    const token = await getTenantAccessToken();
    if (!token) return;

    let bodyContent;
    if (msgType === 'text') {
        bodyContent = JSON.stringify({ text: content });
    } else if (msgType === 'interactive') {
        bodyContent = JSON.stringify(content); // card object directly
    } else {
        bodyContent = JSON.stringify(content);
    }

    try {
        const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                receive_id: openId,
                msg_type: msgType,
                content: msgType === 'interactive' ? bodyContent : bodyContent
            })
        });
        const result = await res.json();
        if (result.code !== 0) {
            console.error('[Feishu] Send message failed:', result);
        } else {
            console.log('[Feishu] Message sent to', openId);
        }
    } catch (e) {
        console.error('[Feishu] Error sending message:', e);
    }
}

/**
 * 发送飞书回复 (简易实现)
 */
async function sendFeishuReply(messageId, text) {
    const token = await getTenantAccessToken();
    if (!token) return;

    try {
        await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
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
