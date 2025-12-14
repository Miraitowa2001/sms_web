const { dbWrapper: db } = require('./database');
const nodemailer = require('nodemailer');

class PushService {
    constructor() {
        this.transporter = null;
    }

    /**
     * 获取所有推送配置
     */
    getConfigs() {
        try {
            const rows = db.prepare('SELECT * FROM push_config').all();
            return rows.map(row => ({
                ...row,
                config: JSON.parse(row.config),
                events: JSON.parse(row.events),
                enabled: !!row.enabled
            }));
        } catch (error) {
            console.error('[Push] 获取配置失败:', error);
            return [];
        }
    }

    /**
     * 保存推送配置
     */
    saveConfig(channel, enabled, config, events) {
        const safeConfig = config || {};
        const safeEvents = Array.isArray(events) ? events : [];

        try {
            // 先尝试更新，若不存在则插入，避免新增渠道时更新0行导致配置丢失
            const updateResult = db.prepare(`
                UPDATE push_config 
                SET enabled = ?, config = ?, events = ?, updated_at = datetime('now', 'localtime')
                WHERE channel = ?
            `).run(enabled ? 1 : 0, JSON.stringify(safeConfig), JSON.stringify(safeEvents), channel);

            if (!updateResult.changes) {
                db.prepare(`
                    INSERT INTO push_config (channel, enabled, config, events, updated_at)
                    VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
                `).run(channel, enabled ? 1 : 0, JSON.stringify(safeConfig), JSON.stringify(safeEvents));
            }

            return true;
        } catch (error) {
            console.error('[Push] 保存配置失败:', error);
            return false;
        }
    }

    /**
     * 推送消息入口
     * @param {string} eventType - 事件类型: 'sms', 'call', 'device_status'
     * @param {object} data - 消息数据
     */
    async push(eventType, data) {
        // 补充设备名称
        const devId = data.dev_id || data.devId;
        if (devId) {
            try {
                const device = db.prepare('SELECT name FROM devices WHERE dev_id = ?').get(devId);
                if (device && device.name) {
                    data.devName = device.name;
                }
            } catch (e) {
                // 忽略查询错误
            }
        }

        const configs = this.getConfigs();
        const promises = [];

        for (const config of configs) {
            if (config.enabled && config.events.includes(eventType)) {
                const message = this.formatMessage(eventType, data, config.channel);
                if (message) {
                    switch (config.channel) {
                        case 'wecom':
                            promises.push(this.sendWeCom(config.config, message));
                            break;
                        case 'feishu':
                            promises.push(this.sendFeishu(config.config, message));
                            break;
                        case 'smtp':
                            promises.push(this.sendSmtp(config.config, message));
                            break;
                    }
                }
            }
        }

        await Promise.allSettled(promises);
    }

    /**
     * 获取北京时间字符串
     */
    getBeijingTime() {
        // 强制使用北京时间 (UTC+8)
        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        const beijingTime = new Date(utc + (3600000 * 8));
        
        const pad = n => n < 10 ? '0' + n : n;
        return `${beijingTime.getFullYear()}-${pad(beijingTime.getMonth() + 1)}-${pad(beijingTime.getDate())} ${pad(beijingTime.getHours())}:${pad(beijingTime.getMinutes())}:${pad(beijingTime.getSeconds())}`;
    }

    /**
     * 格式化消息
     */
    formatMessage(eventType, data, channel) {
        // 标准化字段
        const devId = data.dev_id || data.devId || 'unknown';
        const devName = data.devName ? `${data.devName} (${devId})` : devId;
        const slot = data.slot ? `卡${data.slot}` : '未知卡槽';
        const time = this.getBeijingTime();
        
        let title = '';
        let content = '';
        let markdown = '';
        let feishuCard = null;

        // 辅助函数：生成飞书卡片
        const createFeishuCard = (title, color, elements) => ({
            header: { title: { tag: 'plain_text', content: title }, template: color },
            elements: elements
        });

        switch (eventType) {
            case 'sms':
                const isSent = data.direction === 'out';
                const actionTitle = isSent ? '短信外发成功' : '收到新短信';
                const senderLabel = isSent ? '发送给' : '来自';
                const cardColor = isSent ? 'green' : 'blue';

                title = actionTitle;
                content = `内容: ${data.content}\n\n${senderLabel}: ${data.phone_num}\n设备: ${devName}\n卡槽: ${slot}\n时间: ${time}`;
                
                markdown = `### ${actionTitle}\n` +
                           `${senderLabel}: <font color="info">${data.phone_num}</font>\n` +
                           `内容: \n> ${data.content}\n\n` +
                           `<font color="comment">设备: ${devName}</font>\n` +
                           `<font color="comment">卡槽: ${slot}</font>\n` +
                           `<font color="comment">时间: ${time}</font>`;
                
                feishuCard = createFeishuCard(actionTitle, cardColor, [
                    { 
                        tag: 'div', 
                        text: { 
                            tag: 'lark_md', 
                            content: `**来自**: ${data.phone_num}` 
                        } 
                    },
                    { 
                        tag: 'div', 
                        text: { 
                            tag: 'lark_md', 
                            content: data.content 
                        } 
                    },
                    {
                        tag: 'action',
                        actions: [
                            {
                                tag: 'button',
                                text: { tag: 'plain_text', content: '查看状态' },
                                type: 'default',
                                value: { cmd: 'stat', dev_id: devId }
                            }
                        ]
                    },
                    { tag: 'hr' },
                    { 
                        tag: 'note', 
                        elements: [
                            { tag: 'plain_text', content: `设备: ${devName} | ${slot} | ${time}` }
                        ] 
                    }
                ]);
                break;

            case 'call':
                const isHangup = data.msg_type === 603 || data.msg_type === 623;
                title = isHangup ? '通话结束' : '收到来电';
                const callColor = isHangup ? 'grey' : 'orange';
                
                let durationText = '';
                if (data.duration && data.duration > 0) {
                    const m = Math.floor(data.duration / 60);
                    const s = data.duration % 60;
                    durationText = m > 0 ? `${m}分${s}秒` : `${s}秒`;
                }

                content = `号码: ${data.phone_num}\n状态: ${data.call_type}`;
                if (durationText) content += `\n时长: ${durationText}`;
                content += `\n\n设备: ${devName}\n卡槽: ${slot}\n时间: ${time}`;
                
                markdown = `### ${title}\n` +
                           `号码: <font color="info">${data.phone_num}</font>\n` +
                           `状态: <font color="warning">${data.call_type}</font>\n`;
                
                if (durationText) {
                    markdown += `时长: <font color="info">${durationText}</font>\n`;
                }

                markdown += `\n<font color="comment">设备: ${devName}</font>\n` +
                           `<font color="comment">卡槽: ${slot}</font>\n` +
                           `<font color="comment">时间: ${time}</font>`;
                
                feishuCard = createFeishuCard(title, callColor, [
                    { 
                        tag: 'div', 
                        text: { 
                            tag: 'lark_md', 
                            content: `**号码**: ${data.phone_num}\n**状态**: ${data.call_type}${durationText ? `\n**时长**: ${durationText}` : ''}` 
                        } 
                    },
                    {
                        tag: 'action',
                        actions: [
                            {
                                tag: 'button',
                                text: { tag: 'plain_text', content: '查看状态' },
                                type: 'default',
                                value: { cmd: 'stat', dev_id: devId }
                            }
                        ]
                    },
                    { tag: 'hr' },
                    { 
                        tag: 'note', 
                        elements: [
                            { tag: 'plain_text', content: `设备: ${devName} | ${slot} | ${time}` }
                        ] 
                    }
                ]);
                break;

            case 'device_status':
                title = '设备状态更新';
                const statusColor = data.status.includes('异常') || data.status.includes('错误') ? 'warning' : 'info';
                const feishuColor = data.status.includes('异常') || data.status.includes('错误') ? 'red' : 'green';
                
                content = `设备: ${devName}\n状态: ${data.status}\n详情: ${data.detail || '无'}\n时间: ${time}`;
                
                markdown = `### 设备状态更新\n` +
                           `设备: <font color="comment">${devName}</font>\n` +
                           `状态: <font color="${statusColor}">${data.status}</font>\n` +
                           `详情: ${data.detail || '无'}\n` +
                           `<font color="comment">时间: ${time}</font>`;
                
                feishuCard = createFeishuCard('设备状态更新', feishuColor, [
                    { 
                        tag: 'div', 
                        text: { 
                            tag: 'lark_md', 
                            content: `**设备**: ${devName}\n**状态**: ${data.status}` 
                        } 
                    },
                    { 
                        tag: 'div', 
                        text: { 
                            tag: 'lark_md', 
                            content: `详情: ${data.detail || '无'}` 
                        } 
                    },
                    {
                        tag: 'action',
                        actions: [
                            {
                                tag: 'button',
                                text: { tag: 'plain_text', content: '刷新状态' },
                                type: 'default',
                                value: { cmd: 'stat', dev_id: devId }
                            },
                            {
                                tag: 'button',
                                text: { tag: 'plain_text', content: '重启设备' },
                                type: 'danger',
                                value: { cmd: 'restart', dev_id: devId },
                                confirm: {
                                    title: { tag: 'plain_text', content: '确认重启' },
                                    text: { tag: 'plain_text', content: '确定要重启该设备吗？' }
                                }
                            }
                        ]
                    },
                    { tag: 'hr' },
                    { 
                        tag: 'note', 
                        elements: [
                            { tag: 'plain_text', content: `时间: ${time}` }
                        ] 
                    }
                ]);
                break;

            default:
                return null;
        }

        if (channel === 'wecom') {
            return { title, content, markdown };
        } else if (channel === 'feishu') {
            return { title, content, card: feishuCard };
        } else {
            // SMTP HTML format
            const html = `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
                    <div style="background: #4f46e5; color: white; padding: 15px 20px;">
                    </div>
                    <div style="padding: 20px;">
                        <pre style="background: #f8fafc; padding: 15px; border-radius: 6px; font-family: sans-serif; white-space: pre-wrap; color: #334155; border: 1px solid #e2e8f0;">${content}</pre>
                    </div>
                    <div style="background: #f8fafc; padding: 10px 20px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #e0e0e0;">
                        IoT Device Manager
                    </div>
                </div>
            `;
            return { title, content, html };
        }
    }

    /**
     * 发送企业微信 Webhook
     */
    async sendWeCom(config, message) {
        if (!config.webhook) return;
        try {
            // 微信对Markdown支持有限，改用纯文本，效果更稳定
            const payload = {
                msgtype: 'text',
                text: {
                    content: `${message.title}\n\n${message.content}`
                }
            };
            
            const res = await fetch(config.webhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            const result = await res.json();
            if (result.errcode !== 0) {
                console.error('[Push] WeCom failed:', result);
                throw new Error(`WeCom error: ${result.errmsg}`);
            }
            console.log('[Push] WeCom success');
        } catch (error) {
            console.error('[Push] WeCom error:', error);
        }
    }

    /**
     * 发送飞书 Webhook
     */
    async sendFeishu(config, message) {
        if (!config.webhook) return;
        try {
            const payload = {
                msg_type: 'interactive',
                card: message.card
            };

            // 如果有签名校验，需要处理 timestamp 和 sign (这里简化处理，假设用户只配了webhook)
            
            const res = await fetch(config.webhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await res.json();
            if (result.code !== 0) {
                console.error('[Push] Feishu failed:', result);
                throw new Error(`Feishu error: ${result.msg}`);
            }
            console.log('[Push] Feishu success');
        } catch (error) {
            console.error('[Push] Feishu error:', error);
        }
    }

    /**
     * 发送 SMTP 邮件
     */
    async sendSmtp(config, message) {
        if (!config.host || !config.user || !config.pass) return;

        try {
            const transporter = nodemailer.createTransport({
                host: config.host,
                port: config.port || 465,
                secure: config.secure !== false, // true for 465, false for other ports
                auth: {
                    user: config.user,
                    pass: config.pass
                }
            });

            await transporter.sendMail({
                from: config.from || config.user,
                to: config.to,
                subject: `[IoT通知] ${message.title}`,
                text: message.content,
                html: message.html
            });
            
            console.log('[Push] SMTP success');
        } catch (error) {
            console.error('[Push] SMTP error:', error);
        }
    }
}

module.exports = new PushService();
