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
        try {
            const stmt = db.prepare(`
                UPDATE push_config 
                SET enabled = ?, config = ?, events = ?, updated_at = datetime('now', 'localtime')
                WHERE channel = ?
            `);
            stmt.run(enabled ? 1 : 0, JSON.stringify(config), JSON.stringify(events), channel);
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
     * 格式化消息
     */
    formatMessage(eventType, data, channel) {
        const time = new Date().toLocaleString();
        let title = '';
        let content = '';
        let markdown = '';

        switch (eventType) {
            case 'sms':
                title = '收到新短信';
                content = `来自: ${data.phone_num}\n内容: ${data.content}\n设备: ${data.dev_id}\n时间: ${time}`;
                markdown = `**收到新短信**\n> 来自: <font color="info">${data.phone_num}</font>\n> 内容: ${data.content}\n> 设备: ${data.dev_id}\n> 时间: ${time}`;
                break;
            case 'call':
                title = '收到来电';
                content = `来自: ${data.phone_num}\n状态: ${data.call_type}\n设备: ${data.dev_id}\n时间: ${time}`;
                markdown = `**收到来电**\n> 来自: <font color="info">${data.phone_num}</font>\n> 状态: ${data.call_type}\n> 设备: ${data.dev_id}\n> 时间: ${time}`;
                break;
            case 'device_status':
                title = '设备状态更新';
                content = `设备: ${data.devId}\n状态: ${data.status}\nIP: ${data.ip}\n时间: ${time}`;
                markdown = `**设备状态更新**\n> 设备: ${data.devId}\n> 状态: <font color="warning">${data.status}</font>\n> IP: ${data.ip}\n> 时间: ${time}`;
                break;
            default:
                return null;
        }

        if (channel === 'wecom' || channel === 'feishu') {
            return { title, content, markdown };
        } else {
            // SMTP HTML format
            const html = `
                <h3>${title}</h3>
                <p><strong>时间:</strong> ${time}</p>
                <pre style="background: #f5f5f5; padding: 10px; border-radius: 5px;">${content}</pre>
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
            const payload = {
                msgtype: 'markdown',
                markdown: {
                    content: message.markdown
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
            // 飞书富文本格式比较复杂，这里使用简单的 text 或 interactive
            // 为了兼容性，使用 text 加上简单的格式化，或者 interactive card
            const payload = {
                msg_type: 'interactive',
                card: {
                    header: {
                        title: {
                            tag: 'plain_text',
                            content: message.title
                        },
                        template: 'blue'
                    },
                    elements: [
                        {
                            tag: 'div',
                            text: {
                                tag: 'lark_md',
                                content: message.markdown.replace(/\n/g, '\n') // Ensure newlines work
                            }
                        }
                    ]
                }
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
