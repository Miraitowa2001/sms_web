/**
 * IoT设备 - 管理服务路由
 * 提供设备管理、查询等API
 */

const express = require('express');
const router = express.Router();
const { dbWrapper: db } = require('./database');
const { MESSAGE_TYPES } = require('./constants');
const crypto = require('crypto');

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
        
        if (!deviceIp || !cmd) {
            return res.status(400).json({ 
                success: false, 
                error: '缺少必要参数: deviceIp, cmd' 
            });
        }
        
        if (!token) {
            return res.status(400).json({ 
                success: false, 
                error: '缺少必要参数: token（请从开发板后台复制）' 
            });
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
            
            // 记录到日志
            console.log(`[Control] 设备响应:`, result);
            
            res.json({
                success: true,
                data: result,
                command: { cmd, params, url }
            });
            
        } catch (fetchError) {
            clearTimeout(timeoutId);
            if (fetchError.name === 'AbortError') {
                throw new Error('设备请求超时，请检查设备IP是否正确，设备是否在线');
            }
            throw fetchError;
        }
        
    } catch (error) {
        console.error('[Control] 发送控制指令失败:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message || '发送控制指令失败'
        });
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
        console.error('[API] 批量删除短信失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/sms
 * 获取短信记录
 */
router.get('/sms', (req, res) => {
    try {
        const { devId, phoneNum, direction, page = 1, limit = 50 } = req.query;
        const offset = (page - 1) * limit;
        
        let sql = 'SELECT * FROM sms_records WHERE 1=1';
        let countSql = 'SELECT COUNT(*) as total FROM sms_records WHERE 1=1';
        const params = [];
        
        if (devId) {
            sql += ' AND dev_id = ?';
            countSql += ' AND dev_id = ?';
            params.push(devId);
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
        
        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        
        const records = db.prepare(sql).all(...params, parseInt(limit), parseInt(offset));
        const { total } = db.prepare(countSql).get(...params);
        
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
        const { devId, phoneNum, callType, page = 1, limit = 50 } = req.query;
        const offset = (page - 1) * limit;
        
        let sql = 'SELECT * FROM call_records WHERE 1=1';
        let countSql = 'SELECT COUNT(*) as total FROM call_records WHERE 1=1';
        const params = [];
        
        if (devId) {
            sql += ' AND dev_id = ?';
            countSql += ' AND dev_id = ?';
            params.push(devId);
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
        
        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        
        const records = db.prepare(sql).all(...params, parseInt(limit), parseInt(offset));
        const { total } = db.prepare(countSql).get(...params);
        
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
        const { devId, type, page = 1, limit = 100 } = req.query;
        const offset = (page - 1) * limit;
        
        let sql = 'SELECT * FROM messages WHERE 1=1';
        let countSql = 'SELECT COUNT(*) as total FROM messages WHERE 1=1';
        const params = [];
        
        if (devId) {
            sql += ' AND dev_id = ?';
            countSql += ' AND dev_id = ?';
            params.push(devId);
        }
        if (type) {
            sql += ' AND type = ?';
            countSql += ' AND type = ?';
            params.push(parseInt(type));
        }
        
        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        
        const records = db.prepare(sql).all(...params, parseInt(limit), parseInt(offset));
        const { total } = db.prepare(countSql).get(...params);
        
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
            WHERE date(created_at) = date('now', 'localtime')
        `).get();
        const todayCalls = db.prepare(`
            SELECT COUNT(*) as count FROM call_records 
            WHERE date(created_at) = date('now', 'localtime')
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

module.exports = router;
