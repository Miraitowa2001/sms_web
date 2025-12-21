/**
 * IoT设备 - 管理服务路由
 * 提供设备管理、查询等API
 */

const express = require('express');
const router = express.Router();
const { dbWrapper: db } = require('./database');
const { MESSAGE_TYPES } = require('./constants');
const crypto = require('crypto');
const { decryptData } = require('./aesDecrypt');
const config = require('./config');
const pushService = require('./pushService');

// ==================== 设备控制指令 API ====================

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

    // 支持传入 devId 自动查找 IP
    let targetIp = deviceIp;
    // 简单判断：如果不包含点(.)且不包含冒号(:)，则视为设备ID，尝试从数据库查找IP
    if (targetIp && !targetIp.includes('.') && !targetIp.includes(':')) {
        const device = db.prepare('SELECT last_ip FROM devices WHERE dev_id = ?').get(targetIp);
        if (device && device.last_ip) {
            console.log(`[Control] 根据设备ID ${targetIp} 解析到 IP: ${device.last_ip}`);
            targetIp = device.last_ip;
        } else {
            throw new Error(`未找到设备 ${targetIp} 的IP记录，请确保设备已上线`);
        }
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
    
    const url = `http://${targetIp}/ctrl?${urlParams.toString()}`;
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

/**
 * POST /api/control/send
 * 向开发板发送控制指令
 * 
 * 请求体:
 * {
 *   devId: string,      // 设备ID
 *   deviceIp: string,   // 设备IP地址
 *   token: string,      // 设备管理token (可选，如果提供adminUser和adminPassword则自动计算)
 *   adminUser: string,  // 设备管理员用户名 (默认: admin)
 *   adminPassword: string, // 设备管理员密码 (默认: admin)
 *   cmd: string,        // 命令名称 (stat, restart, sendsms, teldial, etc.)
 *   params: object      // 命令参数 (p1, p2, p3, etc.)
 * }
 */
router.post('/control/send', async (req, res) => {
    try {
        const { deviceIp, token, cmd, params = {} } = req.body;
        
        if (!token) {
            return res.status(400).json({ 
                success: false, 
                error: '缺少必要参数: token（请从开发板后台复制）' 
            });
        }
        
        const result = await sendCommandToDevice(deviceIp, token, cmd, params);
        res.json(result);
        
    } catch (error) {
        console.error('[Control] 发送控制指令失败:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message || '发送控制指令失败'
        });
    }
});

// ==================== 9.1 设备控制类命令 ====================

/**
 * POST /api/control/chpwduser
 * 修改用户密码
 */
router.post('/control/chpwduser', async (req, res) => {
    try {
        const { deviceIp, token, password } = req.body;
        if (!password || password.length < 4) {
            return res.status(400).json({ success: false, error: '密码长度不能少于4位' });
        }
        const result = await sendCommandToDevice(deviceIp, token, 'chpwduser', { p1: password });
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/control/now
 * 设置开发板时间
 */
router.post('/control/now', async (req, res) => {
    try {
        const { deviceIp, token, time, auto = 15, timezone = 8 } = req.body;
        const params = { p2: auto, p3: timezone };
        if (time) params.p1 = time;
        const result = await sendCommandToDevice(deviceIp, token, 'now', params);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/control/stat
 * 获取开发板状态
 */
router.post('/control/stat', async (req, res) => {
    try {
        const { deviceIp, token } = req.body;
        const result = await sendCommandToDevice(deviceIp, token, 'stat');
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/control/restart
 * 重启开发板
 */
router.post('/control/restart', async (req, res) => {
    try {
        const { deviceIp, token } = req.body;
        const result = await sendCommandToDevice(deviceIp, token, 'restart');
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/control/pingsec
 * 修改ping间隔秒数
 */
router.post('/control/pingsec', async (req, res) => {
    try {
        const { deviceIp, token, seconds } = req.body;
        if (!seconds || seconds < 10) {
            return res.status(400).json({ success: false, error: '间隔秒数不能小于10' });
        }
        const result = await sendCommandToDevice(deviceIp, token, 'pingsec', { p1: seconds });
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/control/dailyrst
 * 设置每日重启时间
 */
router.post('/control/dailyrst', async (req, res) => {
    try {
        const { deviceIp, token, hour } = req.body;
        if (hour === undefined || hour < 0) {
            return res.status(400).json({ success: false, error: '无效的小时数' });
        }
        const result = await sendCommandToDevice(deviceIp, token, 'dailyrst', { p1: hour });
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== 9.2 卡槽控制命令 ====================

/**
 * POST /api/control/slotoff
 * 指定卡槽关机
 */
router.post('/control/slotoff', async (req, res) => {
    try {
        const { deviceIp, token, slot } = req.body;
        if (![1, 2].includes(parseInt(slot))) {
            return res.status(400).json({ success: false, error: '无效的卡槽号(1或2)' });
        }
        const result = await sendCommandToDevice(deviceIp, token, 'slotoff', { p1: slot });
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/control/slotrst
 * 指定卡槽重启
 */
router.post('/control/slotrst', async (req, res) => {
    try {
        const { deviceIp, token, slot } = req.body;
        if (![1, 2].includes(parseInt(slot))) {
            return res.status(400).json({ success: false, error: '无效的卡槽号(1或2)' });
        }
        const result = await sendCommandToDevice(deviceIp, token, 'slotrst', { p1: slot });
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/control/slotplmn
 * 指定卡注册的运营商
 */
router.post('/control/slotplmn', async (req, res) => {
    try {
        const { deviceIp, token, slot, operatorCode } = req.body;
        if (![1, 2].includes(parseInt(slot))) {
            return res.status(400).json({ success: false, error: '无效的卡槽号(1或2)' });
        }
        const result = await sendCommandToDevice(deviceIp, token, 'slotplmn', { p1: slot, p2: operatorCode || 0 });
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== 9.3 WiFi控制命令 ====================

/**
 * POST /api/control/wf
 * 打开或关闭wifi
 */
router.post('/control/wf', async (req, res) => {
    try {
        const { deviceIp, token, action } = req.body;
        if (!['on', 'off'].includes(action)) {
            return res.status(400).json({ success: false, error: '无效的动作(on或off)' });
        }
        const result = await sendCommandToDevice(deviceIp, token, 'wf', { p1: action });
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/control/addwf
 * 增加wifi热点信息
 */
router.post('/control/addwf', async (req, res) => {
    try {
        const { deviceIp, token, ssid, password } = req.body;
        if (!ssid || !password) {
            return res.status(400).json({ success: false, error: 'SSID和密码不能为空' });
        }
        const result = await sendCommandToDevice(deviceIp, token, 'addwf', { p1: ssid, p2: password });
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/control/delwf
 * 删除wifi热点信息
 */
router.post('/control/delwf', async (req, res) => {
    try {
        const { deviceIp, token, ssid } = req.body;
        if (!ssid) {
            return res.status(400).json({ success: false, error: 'SSID不能为空' });
        }
        const result = await sendCommandToDevice(deviceIp, token, 'delwf', { p1: ssid });
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== 9.4 短信命令 ====================

/**
 * POST /api/control/sendsms
 * 外发短信
 */
router.post('/control/sendsms', async (req, res) => {
    try {
        const { deviceIp, token, slot, phone, content, tid } = req.body;
        if (![1, 2].includes(parseInt(slot))) {
            return res.status(400).json({ success: false, error: '无效的卡槽号(1或2)' });
        }
        if (!phone || !content) {
            return res.status(400).json({ success: false, error: '电话号码和内容不能为空' });
        }
        if (!tid) {
            return res.status(400).json({ success: false, error: 'tid不能为空' });
        }
        const result = await sendCommandToDevice(deviceIp, token, 'sendsms', { 
            p1: slot, 
            p2: phone, 
            p3: content,
            tid: tid
        });
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/control/querysms
 * 查询本地短信库
 */
router.post('/control/querysms', async (req, res) => {
    try {
        const { deviceIp, token, offset = 1, limit = 10, keyword } = req.body;
        const params = { p1: offset, p2: limit };
        if (keyword) params.p3 = keyword;
        const result = await sendCommandToDevice(deviceIp, token, 'querysms', params);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== 9.5 通话命令 ====================

/**
 * POST /api/control/teldial
 * 电话拨号
 */
router.post('/control/teldial', async (req, res) => {
    try {
        const { deviceIp, token, slot, phone, duration = 175, tts, loops = 1, pause = 1, action = 1, tid } = req.body;
        if (![1, 2].includes(parseInt(slot))) {
            return res.status(400).json({ success: false, error: '无效的卡槽号(1或2)' });
        }
        if (!phone) {
            return res.status(400).json({ success: false, error: '电话号码不能为空' });
        }
        const params = {
            p1: slot,
            p2: phone,
            p3: duration,
            p4: tts || '',
            p5: loops,
            p6: pause,
            p7: action
        };
        if (tid) params.tid = tid;
        const result = await sendCommandToDevice(deviceIp, token, 'teldial', params);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/control/telanswer
 * 接听来电
 */
router.post('/control/telanswer', async (req, res) => {
    try {
        const { deviceIp, token, slot, duration = 175, tts, loops = 1, pause = 1, action = 1, tid } = req.body;
        if (![1, 2].includes(parseInt(slot))) {
            return res.status(400).json({ success: false, error: '无效的卡槽号(1或2)' });
        }
        const params = {
            p1: slot,
            p2: duration,
            p3: tts || '',
            p4: loops,
            p5: pause,
            p6: action
        };
        if (tid) params.tid = tid;
        const result = await sendCommandToDevice(deviceIp, token, 'telanswer', params);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/control/telhangup
 * 电话挂机
 */
router.post('/control/telhangup', async (req, res) => {
    try {
        const { deviceIp, token, slot, tid } = req.body;
        if (![1, 2].includes(parseInt(slot))) {
            return res.status(400).json({ success: false, error: '无效的卡槽号(1或2)' });
        }
        const params = { p1: slot };
        if (tid) params.tid = tid;
        const result = await sendCommandToDevice(deviceIp, token, 'telhangup', params);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/control/telstarttts
 * 播放TTS语音
 */
router.post('/control/telstarttts', async (req, res) => {
    try {
        const { deviceIp, token, slot, tts, loops = 0, pause = 1, action = 0, tid } = req.body;
        if (![1, 2].includes(parseInt(slot))) {
            return res.status(400).json({ success: false, error: '无效的卡槽号(1或2)' });
        }
        if (!tts) {
            return res.status(400).json({ success: false, error: 'TTS内容不能为空' });
        }
        const params = {
            p1: slot,
            p2: tts,
            p3: loops,
            p4: pause,
            p5: action
        };
        if (tid) params.tid = tid;
        const result = await sendCommandToDevice(deviceIp, token, 'telstarttts', params);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/control/telstoptts
 * 停止播放TTS语音
 */
router.post('/control/telstoptts', async (req, res) => {
    try {
        const { deviceIp, token, slot, action = 0, tid } = req.body;
        if (![1, 2].includes(parseInt(slot))) {
            return res.status(400).json({ success: false, error: '无效的卡槽号(1或2)' });
        }
        const params = { p1: slot, p2: action };
        if (tid) params.tid = tid;
        const result = await sendCommandToDevice(deviceIp, token, 'telstoptts', params);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/control/telkeypress
 * 本地电话按键
 */
router.post('/control/telkeypress', async (req, res) => {
    try {
        const { deviceIp, token, slot, keys, duration = 200, interval = 100, tid } = req.body;
        if (![1, 2].includes(parseInt(slot))) {
            return res.status(400).json({ success: false, error: '无效的卡槽号(1或2)' });
        }
        if (!keys) {
            return res.status(400).json({ success: false, error: '按键序列不能为空' });
        }
        const params = {
            p1: slot,
            p2: keys,
            p3: duration,
            p4: interval
        };
        if (tid) params.tid = tid;
        const result = await sendCommandToDevice(deviceIp, token, 'telkeypress', params);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/control/querytel
 * 查询本地通话记录
 */
router.post('/control/querytel', async (req, res) => {
    try {
        const { deviceIp, token, offset = 1, limit = 10, type = 0, keyword } = req.body;
        const params = { p1: offset, p2: limit, p3: type };
        if (keyword) params.p4 = keyword;
        const result = await sendCommandToDevice(deviceIp, token, 'querytel', params);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== 9.6 OTA升级命令 ====================

/**
 * POST /api/control/dailyota
 * 设置每日OTA升级时间
 */
router.post('/control/dailyota', async (req, res) => {
    try {
        const { deviceIp, token, hour } = req.body;
        if (hour === undefined || hour < 0) {
            return res.status(400).json({ success: false, error: '无效的小时数' });
        }
        const result = await sendCommandToDevice(deviceIp, token, 'dailyota', { p1: hour });
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/control/otanow
 * 立即执行OTA升级
 */
router.post('/control/otanow', async (req, res) => {
    try {
        const { deviceIp, token, tid } = req.body;
        const params = {};
        if (tid) params.tid = tid;
        const result = await sendCommandToDevice(deviceIp, token, 'otanow', params);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/control/token
 * 计算设备token
 */
router.get('/control/token', (req, res) => {
    const { devId, username = 'admin', password = 'admin' } = req.query;
    
    if (!devId) {
        return res.status(400).json({
            success: false,
            error: '缺少必要参数: devId'
        });
    }
    
    const token = calculateToken(devId, username, password);
    res.json({
        success: true,
        data: {
            token,
            formula: `sha256("${devId}|${username}|${password}")`
        }
    });
});

// ==================== 设备管理 API ====================

/**
 * GET /api/devices
 * 获取设备列表
 */
router.get('/devices', (req, res) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;
        
        let sql = 'SELECT * FROM devices';
        let countSql = 'SELECT COUNT(*) as total FROM devices';
        const params = [];
        
        if (status) {
            sql += ' WHERE status = ?';
            countSql += ' WHERE status = ?';
            params.push(status);
        }
        
        sql += ' ORDER BY last_seen_at DESC LIMIT ? OFFSET ?';
        
        const devices = db.prepare(sql).all(...params, parseInt(limit), parseInt(offset));
        const { total } = db.prepare(countSql).get(...params);
        
        // 获取每个设备的SIM卡信息
        const devicesWithSim = devices.map(device => {
            const simCards = db.prepare('SELECT * FROM sim_cards WHERE dev_id = ?').all(device.dev_id);
            return { ...device, sim_cards: simCards };
        });
        
        res.json({
            success: true,
            data: devicesWithSim,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total
            }
        });
    } catch (error) {
        console.error('[API] 获取设备列表失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/devices/:devId/sim-config
 * 设置SIM卡配置（如时区）
 */
router.post('/devices/:devId/sim-config', (req, res) => {
    try {
        const { devId } = req.params;
        const { slot, timezone } = req.body;
        
        if (!slot || timezone === undefined) {
             return res.status(400).json({ success: false, error: '缺少参数: slot, timezone' });
        }

        const result = db.prepare('UPDATE sim_cards SET timezone = ? WHERE dev_id = ? AND slot = ?').run(timezone, devId, slot);
        
        if (result.changes === 0) {
             return res.status(404).json({ success: false, error: '未找到该卡槽记录，请等待设备上报后再设置' });
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/devices/refresh
 * 刷新设备状态 - 向设备发送stat命令获取最新状态
 * 
 * 请求体:
 * {
 *   devId: string,      // 设备ID
 *   deviceIp: string,   // 设备IP
 *   token: string       // 设备token
 * }
 */
router.post('/devices/refresh', async (req, res) => {
    try {
        const { devId, deviceIp, token } = req.body;
        
        if (!devId || !deviceIp) {
            return res.status(400).json({
                success: false,
                error: '缺少必要参数: devId, deviceIp'
            });
        }
        
        // 如果没有提供token，尝试从数据库获取设备信息
        // 暂时跳过，直接发送不需要token的ping
        const url = `http://${deviceIp}/ctrl?token=${token || ''}&cmd=stat`;
        console.log(`[Refresh] 刷新设备状态: ${devId} -> ${url}`);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        try {
            const response = await fetch(url, {
                method: 'GET',
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            
            // 设备响应，说明在线，更新最后在线时间
            const now = new Date().toISOString();
            db.prepare(`
                UPDATE devices 
                SET status = 'online', last_seen_at = ?, updated_at = ?
                WHERE dev_id = ?
            `).run(now, now, devId);
            
            let result;
            try {
                result = await response.json();
            } catch {
                result = await response.text();
            }
            
            res.json({
                success: true,
                status: 'online',
                data: result
            });
            
        } catch (fetchError) {
            clearTimeout(timeoutId);
            
            // 设备无响应，标记为离线
            const now = new Date().toISOString();
            db.prepare(`
                UPDATE devices 
                SET status = 'offline', updated_at = ?
                WHERE dev_id = ?
            `).run(now, devId);
            
            res.json({
                success: true,
                status: 'offline',
                error: fetchError.name === 'AbortError' ? '设备无响应' : fetchError.message
            });
        }
        
    } catch (error) {
        console.error('[Refresh] 刷新设备状态失败:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/devices/refresh-all
 * 批量刷新所有设备状态
 */
router.post('/devices/refresh-all', async (req, res) => {
    try {
        const devices = db.prepare('SELECT dev_id, last_ip FROM devices WHERE last_ip IS NOT NULL').all();
        
        if (devices.length === 0) {
            return res.json({
                success: true,
                message: '没有可刷新的设备',
                results: []
            });
        }
        
        console.log(`[Refresh] 批量刷新 ${devices.length} 个设备状态`);
        
        // 并发刷新所有设备（限制并发数）
        const results = await Promise.all(devices.map(async (device) => {
            const url = `http://${device.last_ip}/ctrl?cmd=stat`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            
            try {
                const response = await fetch(url, {
                    method: 'GET',
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                
                // 在线
                const now = new Date().toISOString();
                db.prepare(`
                    UPDATE devices 
                    SET status = 'online', last_seen_at = ?, updated_at = ?
                    WHERE dev_id = ?
                `).run(now, now, device.dev_id);
                
                return { devId: device.dev_id, status: 'online' };
                
            } catch (err) {
                clearTimeout(timeoutId);
                
                // 离线
                const now = new Date().toISOString();
                db.prepare(`
                    UPDATE devices 
                    SET status = 'offline', updated_at = ?
                    WHERE dev_id = ?
                `).run(now, device.dev_id);
                
                return { devId: device.dev_id, status: 'offline' };
            }
        }));
        
        const online = results.filter(r => r.status === 'online').length;
        const offline = results.filter(r => r.status === 'offline').length;
        
        console.log(`[Refresh] 刷新完成: ${online} 在线, ${offline} 离线`);
        
        res.json({
            success: true,
            message: `刷新完成: ${online} 在线, ${offline} 离线`,
            results,
            summary: { online, offline, total: devices.length }
        });
        
    } catch (error) {
        console.error('[Refresh] 批量刷新设备状态失败:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/devices/:devId
 * 获取单个设备详情
 */
router.get('/devices/:devId', (req, res) => {
    try {
        const { devId } = req.params;
        
        const device = db.prepare('SELECT * FROM devices WHERE dev_id = ?').get(devId);
        if (!device) {
            return res.status(404).json({ success: false, error: '设备不存在' });
        }
        
        const simCards = db.prepare('SELECT * FROM sim_cards WHERE dev_id = ?').all(devId);
        
        res.json({
            success: true,
            data: { ...device, sim_cards: simCards }
        });
    } catch (error) {
        console.error('[API] 获取设备详情失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/devices
 * 手动添加设备
 */
router.post('/devices', (req, res) => {
    try {
        const { devId, name, ip } = req.body;
        
        if (!devId) {
            return res.status(400).json({ success: false, error: '设备ID不能为空' });
        }
        
        // 检查设备是否已存在
        const existing = db.prepare('SELECT dev_id FROM devices WHERE dev_id = ?').get(devId);
        if (existing) {
            return res.status(400).json({ success: false, error: '设备ID已存在' });
        }
        
        const now = new Date().toISOString();
        const stmt = db.prepare(`
            INSERT INTO devices (dev_id, name, last_ip, status, created_at, updated_at)
            VALUES (?, ?, ?, 'offline', ?, ?)
        `);
        stmt.run(devId, name || '', ip || null, now, now);
        
        console.log(`[API] 手动添加设备: ${devId}`);
        
        res.json({ 
            success: true, 
            message: '设备添加成功',
            data: { dev_id: devId, name, last_ip: ip, status: 'offline' }
        });
    } catch (error) {
        console.error('[API] 添加设备失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * PUT /api/devices/:devId
 * 更新设备信息（如名称）
 */
router.put('/devices/:devId', (req, res) => {
    try {
        const { devId } = req.params;
        const { name } = req.body;
        
        const stmt = db.prepare('UPDATE devices SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE dev_id = ?');
        const result = stmt.run(name || '', devId);
        
        if (result.changes === 0) {
            return res.status(404).json({ success: false, error: '设备不存在' });
        }
        
        res.json({ success: true, message: '更新成功' });
    } catch (error) {
        console.error('[API] 更新设备失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /api/devices/:devId
 * 删除设备
 */
router.delete('/devices/:devId', (req, res) => {
    try {
        const { devId } = req.params;
        
        // 删除关联数据
        db.prepare('DELETE FROM sim_cards WHERE dev_id = ?').run(devId);
        db.prepare('DELETE FROM messages WHERE dev_id = ?').run(devId);
        db.prepare('DELETE FROM sms_records WHERE dev_id = ?').run(devId);
        db.prepare('DELETE FROM call_records WHERE dev_id = ?').run(devId);
        
        const result = db.prepare('DELETE FROM devices WHERE dev_id = ?').run(devId);
        
        if (result.changes === 0) {
            return res.status(404).json({ success: false, error: '设备不存在' });
        }
        
        res.json({ success: true, message: '删除成功' });
    } catch (error) {
        console.error('[API] 删除设备失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== 短信记录 API ====================

/**
 * POST /api/sms/batch-delete
 * 批量删除短信记录
 */
router.post('/sms/batch-delete', (req, res) => {
    try {
        const { ids } = req.body;
        
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, error: '请提供要删除的记录ID' });
        }
        
        const placeholders = ids.map(() => '?').join(',');
        const result = db.prepare(`DELETE FROM sms_records WHERE id IN (${placeholders})`).run(...ids);
        
        res.json({ 
            success: true, 
            message: `成功删除 ${result.changes} 条记录`,
            deleted: result.changes
        });
    } catch (error) {
        console.error('[API] 批量删除短信记录失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/sms
 * 获取短信记录
 */
router.get('/sms', (req, res) => {
    try {
        const { devId, phoneNum, direction, dateStart, dateEnd, page = 1, limit = 50, export: exportType } = req.query;
        const offset = (page - 1) * limit;
        
        let sql = 'SELECT * FROM sms_records WHERE 1=1';
        let countSql = 'SELECT COUNT(*) as total FROM sms_records WHERE 1=1';
        const params = [];
        
        if (devId) {
            sql += ' AND dev_id = ?';
            countSql += ' AND dev_id = ?';
            params.push(devId);
        }
        if (req.query.ids) {
            const ids = req.query.ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));
            if (ids.length > 0) {
                const placeholders = ids.map(() => '?').join(',');
                sql += ` AND id IN (${placeholders})`;
                countSql += ` AND id IN (${placeholders})`;
                params.push(...ids);
            }
        }
        if (phoneNum) {
            sql += ' AND phone_num LIKE ?';
            countSql += ' AND phone_num LIKE ?';
            params.push(`%${phoneNum}%`);
        }
        if (direction) {
            sql += ' AND direction = ?';
            countSql += ' AND direction = ?';
            params.push(direction);
        }
        if (req.query.slot) {
            sql += ' AND slot = ?';
            countSql += ' AND slot = ?';
            params.push(req.query.slot);
        }
        if (dateStart) {
            // sms_time 已经是 YYYY-MM-DD HH:mm:ss 格式，直接截取日期比较
            sql += ` AND DATE(sms_time) >= ?`;
            countSql += ` AND DATE(sms_time) >= ?`;
            params.push(dateStart);
        }
        if (dateEnd) {
            sql += ` AND DATE(sms_time) <= ?`;
            countSql += ` AND DATE(sms_time) <= ?`;
            params.push(dateEnd);
        }
        
        sql += ' ORDER BY created_at DESC';
        
        // 如果不是导出，则添加分页
        if (exportType !== 'csv') {
            sql += ' LIMIT ? OFFSET ?';
            params.push(parseInt(limit), parseInt(offset));
        }
        
        const records = db.prepare(sql).all(...params);
        
        if (exportType === 'csv') {
            const headers = ['ID', '设备ID', '卡槽', '方向', '号码', '内容', '时间'];
            const csvContent = [
                headers.join(','),
                ...records.map(r => [
                    r.id,
                    r.dev_id,
                    r.slot,
                    r.direction === 'in' ? '接收' : '发送',
                    r.phone_num,
                    `"${(r.content || '').replace(/"/g, '""')}"`,
                    r.sms_time || r.created_at
                ].join(','))
            ].join('\n');
            
            res.header('Content-Type', 'text/csv');
            res.header('Content-Disposition', `attachment; filename="sms_export_${new Date().getTime()}.csv"`);
            return res.send('\uFEFF' + csvContent); // 添加BOM以支持Excel中文
        }
        
        const { total } = db.prepare(countSql).get(...params.slice(0, params.length - 2)); // 去掉limit和offset参数
        
        res.json({
            success: true,
            data: records,
            pagination: { page: parseInt(page), limit: parseInt(limit), total }
        });
    } catch (error) {
        console.error('[API] 获取短信记录失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/sms/latest-text
 * 获取最新短信（纯文本格式，适合快捷指令）
 */
router.get('/sms/latest-text', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 2;
        const direction = req.query.direction || 'in';
        
        let sql = 'SELECT * FROM sms_records WHERE direction = ? ORDER BY created_at DESC LIMIT ?';
        const records = db.prepare(sql).all(direction, limit);
        
        const text = records.map(r => {
            let timeStr = r.sms_time || r.created_at;
            // 如果是时间戳（纯数字），转换为可读格式
            if (timeStr && /^\d+$/.test(timeStr)) {
                try {
                    // 假设服务器是UTC时间，或者时间戳是UTC时间
                    // 用户要求+8小时才是北京时间，说明当前输出的是UTC时间
                    // 我们直接在UTC时间戳基础上加8小时，然后用UTC方法获取时间
                    // 这样可以得到 "UTC+8" 的时间值
                    const ts = parseInt(timeStr) * 1000;
                    const date = new Date(ts + 8 * 3600 * 1000);
                    
                    const pad = n => n < 10 ? '0' + n : n;
                    // 使用 getUTC* 方法，获取的是加上8小时后的时间
                    timeStr = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
                } catch (e) {
                    // 转换失败则保持原样
                }
            }
            return `来自: ${r.phone_num}\n时间: ${timeStr}\n内容: ${r.content}`;
        }).join('\n\n----------------\n\n');
        
        res.set('Content-Type', 'text/plain; charset=utf-8');
        res.send(text || '暂无新短信');
    } catch (error) {
        res.status(500).send('获取失败: ' + error.message);
    }
});

/**
 * GET /api/sms/:devId
 * 获取指定设备的短信记录
 */
router.get('/sms/:devId', (req, res) => {
    try {
        const { devId } = req.params;
        const { page = 1, limit = 50 } = req.query;
        const offset = (page - 1) * limit;
        
        const records = db.prepare(`
            SELECT * FROM sms_records 
            WHERE dev_id = ? 
            ORDER BY created_at DESC 
            LIMIT ? OFFSET ?
        `).all(devId, parseInt(limit), parseInt(offset));
        
        const { total } = db.prepare('SELECT COUNT(*) as total FROM sms_records WHERE dev_id = ?').get(devId);
        
        res.json({
            success: true,
            data: records,
            pagination: { page: parseInt(page), limit: parseInt(limit), total }
        });
    } catch (error) {
        console.error('[API] 获取短信记录失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== 通话记录 API ====================

/**
 * POST /api/calls/batch-delete
 * 批量删除通话记录
 */
router.post('/calls/batch-delete', (req, res) => {
    try {
        const { ids } = req.body;
        
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, error: '请提供要删除的记录ID' });
        }
        
        const placeholders = ids.map(() => '?').join(',');
        const result = db.prepare(`DELETE FROM call_records WHERE id IN (${placeholders})`).run(...ids);
        
        res.json({ 
            success: true, 
            message: `成功删除 ${result.changes} 条记录`,
            deleted: result.changes
        });
    } catch (error) {
        console.error('[API] 批量删除通话记录失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/calls
 * 获取通话记录
 */
router.get('/calls', (req, res) => {
    try {
        const { devId, phoneNum, callType, dateStart, dateEnd, page = 1, limit = 50, export: exportType } = req.query;
        const offset = (page - 1) * limit;
        
        let sql = 'SELECT * FROM call_records WHERE 1=1';
        let countSql = 'SELECT COUNT(*) as total FROM call_records WHERE 1=1';
        const params = [];
        
        if (devId) {
            sql += ' AND dev_id = ?';
            countSql += ' AND dev_id = ?';
            params.push(devId);
        }
        if (req.query.ids) {
            const ids = req.query.ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));
            if (ids.length > 0) {
                const placeholders = ids.map(() => '?').join(',');
                sql += ` AND id IN (${placeholders})`;
                countSql += ` AND id IN (${placeholders})`;
                params.push(...ids);
            }
        }
        if (phoneNum) {
            sql += ' AND phone_num LIKE ?';
            countSql += ' AND phone_num LIKE ?';
            params.push(`%${phoneNum}%`);
        }
        if (callType) {
            sql += ' AND call_type = ?';
            countSql += ' AND call_type = ?';
            params.push(callType);
        }
        if (req.query.slot) {
            sql += ' AND slot = ?';
            countSql += ' AND slot = ?';
            params.push(req.query.slot);
        }
        if (dateStart) {
            // start_time 已经是 YYYY-MM-DD HH:mm:ss 格式，直接截取日期比较
            sql += ` AND DATE(start_time) >= ?`;
            countSql += ` AND DATE(start_time) >= ?`;
            params.push(dateStart);
        }
        if (dateEnd) {
            sql += ` AND DATE(start_time) <= ?`;
            countSql += ` AND DATE(start_time) <= ?`;
            params.push(dateEnd);
        }
        
        sql += ' ORDER BY created_at DESC';
        
        if (exportType !== 'csv') {
            sql += ' LIMIT ? OFFSET ?';
            params.push(parseInt(limit), parseInt(offset));
        }
        
        const records = db.prepare(sql).all(...params);
        
        if (exportType === 'csv') {
            const headers = ['ID', '设备ID', '卡槽', '消息类型', '通话分类', '号码', '时间', '时长'];
            const csvContent = [
                headers.join(','),
                ...records.map(r => [
                    r.id,
                    r.dev_id,
                    r.slot,
                    r.msg_type,
                    r.call_type,
                    r.phone_num,
                    r.start_time || r.created_at,
                    r.duration
                ].join(','))
            ].join('\n');
            
            res.header('Content-Type', 'text/csv');
            res.header('Content-Disposition', `attachment; filename="calls_export_${new Date().getTime()}.csv"`);
            return res.send('\uFEFF' + csvContent);
        }
        
        const { total } = db.prepare(countSql).get(...params.slice(0, params.length - 2));
        
        res.json({
            success: true,
            data: records,
            pagination: { page: parseInt(page), limit: parseInt(limit), total }
        });
    } catch (error) {
        console.error('[API] 获取通话记录失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== 消息日志 API ====================

/**
 * POST /api/messages/batch-delete
 * 批量删除消息日志
 */
router.post('/messages/batch-delete', (req, res) => {
    try {
        const { ids } = req.body;
        
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, error: '请提供要删除的记录ID' });
        }
        
        const placeholders = ids.map(() => '?').join(',');
        const result = db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);
        
        res.json({ 
            success: true, 
            message: `成功删除 ${result.changes} 条记录`,
            deleted: result.changes
        });
    } catch (error) {
        console.error('[API] 批量删除消息日志失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/messages
 * 获取消息日志
 */
router.get('/messages', (req, res) => {
    try {
        const { devId, type, msgType, msgCategory, dateStart, dateEnd, page = 1, limit = 100, export: exportType } = req.query;
        const offset = (page - 1) * limit;
        
        // 修复时间显示问题：数据库存储的是UTC时间，查询时转换为UTC+8
        // 注意：现在 created_at 已经是北京时间格式，不需要再转换
        let sql = "SELECT id, dev_id, type, type_name, raw_data, created_at FROM messages WHERE 1=1";
        let countSql = 'SELECT COUNT(*) as total FROM messages WHERE 1=1';
        const params = [];
        
        if (devId) {
            sql += ' AND dev_id = ?';
            countSql += ' AND dev_id = ?';
            params.push(devId);
        }
        if (req.query.ids) {
            const ids = req.query.ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));
            if (ids.length > 0) {
                const placeholders = ids.map(() => '?').join(',');
                sql += ` AND id IN (${placeholders})`;
                countSql += ` AND id IN (${placeholders})`;
                params.push(...ids);
            }
        }
        
        // 支持按消息大类筛选
        if (msgCategory) {
            const categoryRanges = {
                'network': [100, 102],      // 联网消息
                'sim': [202, 209],          // SIM卡消息
                'sms': [501, 502],          // 短信消息
                'call': [601, 642],         // 电话消息(包括601-623和641-642)
                'call_ctrl': [681, 689],    // 电话控制回应
                'command': [401, 402],      // 命令应答
                'module': [301, 301]        // 通讯模组
            };
            
            if (categoryRanges[msgCategory]) {
                const [min, max] = categoryRanges[msgCategory];
                sql += ' AND type >= ? AND type <= ?';
                countSql += ' AND type >= ? AND type <= ?';
                params.push(min, max);
            }
        }
        // 支持按具体消息类型筛选
        else {
            const messageType = type || msgType;
            if (messageType) {
                sql += ' AND type = ?';
                countSql += ' AND type = ?';
                params.push(parseInt(messageType));
            }
        }
        if (dateStart) {
            sql += " AND DATE(created_at) >= ?";
            countSql += " AND DATE(created_at) >= ?";
            params.push(dateStart);
        }
        if (dateEnd) {
            sql += " AND DATE(created_at) <= ?";
            countSql += " AND DATE(created_at) <= ?";
            params.push(dateEnd);
        }
        
        sql += ' ORDER BY created_at DESC';
        
        if (exportType !== 'csv') {
            sql += ' LIMIT ? OFFSET ?';
            params.push(parseInt(limit), parseInt(offset));
        }
        
        const records = db.prepare(sql).all(...params);
        
        if (exportType === 'csv') {
            const headers = ['ID', '设备ID', '消息类型', '类型名称', '原始数据', '时间'];
            const csvContent = [
                headers.join(','),
                ...records.map(r => [
                    r.id,
                    r.dev_id,
                    r.type,
                    r.type_name,
                    `"${(r.raw_data || '').replace(/"/g, '""')}"`,
                    r.created_at
                ].join(','))
            ].join('\n');
            
            res.header('Content-Type', 'text/csv');
            res.header('Content-Disposition', `attachment; filename="messages_export_${new Date().getTime()}.csv"`);
            return res.send('\uFEFF' + csvContent);
        }
        
        const { total } = db.prepare(countSql).get(...params.slice(0, params.length - 2));
        
        res.json({
            success: true,
            data: records,
            pagination: { page: parseInt(page), limit: parseInt(limit), total }
        });
    } catch (error) {
        console.error('[API] 获取消息日志失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== 统计 API ====================

/**
 * GET /api/stats
 * 获取统计信息
 */
router.get('/stats', (req, res) => {
    try {
        const deviceCount = db.prepare('SELECT COUNT(*) as count FROM devices').get();
        const onlineCount = db.prepare("SELECT COUNT(*) as count FROM devices WHERE status = 'online'").get();
        const smsCount = db.prepare('SELECT COUNT(*) as count FROM sms_records').get();
        const callCount = db.prepare('SELECT COUNT(*) as count FROM call_records').get();
        
        // 今日统计
        const todaySms = db.prepare(`
            SELECT COUNT(*) as count FROM sms_records 
            WHERE date(created_at, '+8 hours') = date('now', '+8 hours')
        `).get();
        const todayCalls = db.prepare(`
            SELECT COUNT(*) as count FROM call_records 
            WHERE date(created_at, '+8 hours') = date('now', '+8 hours')
        `).get();
        
        res.json({
            success: true,
            data: {
                devices: {
                    total: deviceCount.count,
                    online: onlineCount.count,
                    offline: deviceCount.count - onlineCount.count
                },
                sms: {
                    total: smsCount.count,
                    today: todaySms.count
                },
                calls: {
                    total: callCount.count,
                    today: todayCalls.count
                }
            }
        });
    } catch (error) {
        console.error('[API] 获取统计信息失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/message-types
 * 获取所有消息类型定义
 */
router.get('/message-types', (req, res) => {
    res.json({
        success: true,
        data: MESSAGE_TYPES
    });
});

// ==================== 消息推送配置 API ====================

// 获取推送配置
router.get('/push-config', (req, res) => {
    try {
        const configs = pushService.getConfigs();
        res.json(configs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 保存推送配置
router.post('/push-config', (req, res) => {
    const { channel, enabled, config, events } = req.body;
    if (!channel) {
        return res.status(400).json({ error: '缺少 channel 参数' });
    }
    
    try {
        const success = pushService.saveConfig(channel, enabled, config, events);
        if (success) {
            res.json({ success: true });
        } else {
            res.status(500).json({ error: '保存失败' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 测试推送
router.post('/push-test', async (req, res) => {
    const { channel, config } = req.body;
    
    try {
        const testData = {
            phone_num: '13800138000',
            content: '这是一条测试消息',
            dev_id: 'TEST_DEVICE',
            call_type: 'incoming',
            status: 'online',
            ip: '192.168.1.100'
        };

        const message = pushService.formatMessage('sms', testData, channel);
        
        if (channel === 'wecom') {
            await pushService.sendWeCom(config, message);
        } else if (channel === 'feishu') {
            await pushService.sendFeishu(config, message);
        } else if (channel === 'smtp') {
            await pushService.sendSmtp(config, message);
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
