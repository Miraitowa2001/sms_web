/**
 * IoT设备 - 消息处理服务
 * 处理各种类型的推送消息
 */

const { dbWrapper: db } = require('./database');
const { getMessageTypeName, getMessageCategory, DEVICE_STATUS, SIM_STATUS } = require('./constants');
const pushService = require('./pushService');

class MessageHandler {
    
    /**
     * 处理推送消息的主入口
     * @param {Object} data - 接收到的消息数据
     */
    handleMessage(data) {
        const { devId, type } = data;
        
        if (!devId || type === undefined) {
            console.warn('[Handler] 无效的消息数据:', data);
            return { success: false, error: '无效的消息数据' };
        }

        // 记录原始消息
        this.recordMessage(devId, type, data);

        // 根据消息类型分发处理
        const category = getMessageCategory(type);
        
        switch (category) {
            case 'network':
                return this.handleNetworkMessage(type, data);
            case 'sim':
                return this.handleSimMessage(type, data);
            case 'sms':
                return this.handleSmsMessage(type, data);
            case 'call':
                return this.handleCallMessage(type, data);
            case 'system':
                return this.handleSystemMessage(type, data);
            default:
                console.log(`[Handler] 收到消息 type=${type}: ${getMessageTypeName(type)}`);
                return { success: true };
        }
    }

    /**
     * 记录消息到数据库
     */
    recordMessage(devId, type, data) {
        try {
            const stmt = db.prepare(`
                INSERT INTO messages (dev_id, type, type_name, raw_data)
                VALUES (?, ?, ?, ?)
            `);
            stmt.run(devId, type, getMessageTypeName(type), JSON.stringify(data));
        } catch (error) {
            console.error('[Handler] 记录消息失败:', error);
        }
    }

    /**
     * 处理网络联网消息 (100-102)
     */
    handleNetworkMessage(type, data) {
        const { devId, ip, ssid, dbm, hwVer, slotInfo } = data;
        
        console.log(`[Network] 设备 ${devId} ${getMessageTypeName(type)}, IP: ${ip}, SSID: ${ssid}`);

        // 更新或创建设备记录
        const existingDevice = db.prepare('SELECT id FROM devices WHERE dev_id = ?').get(devId);
        
        if (existingDevice) {
            const stmt = db.prepare(`
                UPDATE devices 
                SET last_ip = ?, last_ssid = ?, last_dbm = ?, hw_ver = ?,
                    status = ?, last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE dev_id = ?
            `);
            stmt.run(ip || '', ssid || '', dbm || 0, hwVer || '', DEVICE_STATUS.ONLINE, devId);
        } else {
            const stmt = db.prepare(`
                INSERT INTO devices (dev_id, last_ip, last_ssid, last_dbm, hw_ver, status, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `);
            stmt.run(devId, ip || '', ssid || '', dbm || 0, hwVer || '', DEVICE_STATUS.ONLINE);
        }

        // 如果有卡槽信息，更新SIM卡状态
        if (slotInfo) {
            this.updateSlotInfo(devId, slotInfo);
        }

        // 推送设备状态更新
        pushService.push('device_status', {
            devId,
            status: getMessageTypeName(type),
            ip: ip || 'unknown'
        });

        return { success: true };
    }

    /**
     * 处理SIM卡消息 (202-209)
     */
    handleSimMessage(type, data) {
        const { devId, slot, iccId, imsi, msIsdn, dbm, plmn } = data;
        
        console.log(`[SIM] 设备 ${devId} 卡槽${slot}: ${getMessageTypeName(type)}`);

        // 确保设备存在
        this.ensureDeviceExists(devId);

        let status = SIM_STATUS.UNKNOWN;
        switch (type) {
            case 202: status = SIM_STATUS.REGISTERING; break;
            case 203: // ID获取，状态保持
            case 204: status = SIM_STATUS.READY; break;
            case 205: status = SIM_STATUS.REMOVED; break;
            case 209: status = SIM_STATUS.ERROR; break;
        }

        // 更新或创建SIM卡记录
        const existingSim = db.prepare('SELECT id FROM sim_cards WHERE dev_id = ? AND slot = ?').get(devId, slot);
        
        if (existingSim) {
            const stmt = db.prepare(`
                UPDATE sim_cards 
                SET iccid = COALESCE(NULLIF(?, ''), iccid),
                    imsi = COALESCE(NULLIF(?, ''), imsi),
                    msisdn = COALESCE(NULLIF(?, ''), msisdn),
                    dbm = COALESCE(?, dbm),
                    plmn = COALESCE(NULLIF(?, ''), plmn),
                    status = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE dev_id = ? AND slot = ?
            `);
            stmt.run(iccId || '', imsi || '', msIsdn || '', dbm, plmn || '', status, devId, slot);
        } else {
            const stmt = db.prepare(`
                INSERT INTO sim_cards (dev_id, slot, iccid, imsi, msisdn, dbm, plmn, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run(devId, slot, iccId || '', imsi || '', msIsdn || '', dbm || 0, plmn || '', status);
        }

        // 更新设备最后在线时间
        this.updateDeviceLastSeen(devId);

        return { success: true };
    }

    /**
     * 处理短信消息 (501-502)
     */
    handleSmsMessage(type, data) {
        const { devId, slot, phoneNum, content, time } = data;
        
        console.log(`[SMS] 收到短信: ${phoneNum} -> ${content}`);

        // 记录短信
        try {
            const stmt = db.prepare(`
                INSERT INTO sms_records (dev_id, slot, phone_num, content, sms_time, direction)
                VALUES (?, ?, ?, ?, ?, 'in')
            `);
            stmt.run(devId, slot, phoneNum, content, time || new Date().toISOString());
        } catch (error) {
            console.error('[SMS] 记录短信失败:', error);
        }

        // 推送短信通知
        pushService.push('sms', {
            dev_id: devId,
            phone_num: phoneNum,
            content: content
        });

        return { success: true };
    }

    /**
     * 处理电话消息 (601-642)
     */
    handleCallMessage(type, data) {
        const { devId, slot, phoneNum, callType, time } = data;
        
        console.log(`[Call] 电话消息: ${phoneNum} (${getMessageTypeName(type)})`);

        // 记录通话
        try {
            const stmt = db.prepare(`
                INSERT INTO call_records (dev_id, slot, phone_num, msg_type, call_type, call_time)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            stmt.run(devId, slot, phoneNum, type, getMessageTypeName(type), time || new Date().toISOString());
        } catch (error) {
            console.error('[Call] 记录通话失败:', error);
        }

        // 仅在来电振铃(601)时推送通知，避免重复推送
        if (type === 601) {
            pushService.push('call', {
                dev_id: devId,
                phone_num: phoneNum,
                call_type: getMessageTypeName(type)
            });
        }

        return { success: true };
    }

    /**
     * 处理系统消息 (998 PING)
     */
    handleSystemMessage(type, data) {
        const { devId } = data;
        
        // PING消息，更新设备状态
        this.ensureDeviceExists(devId);
        this.updateDeviceLastSeen(devId);
        
        console.log(`[System] 设备 ${devId} PING`);
        return { success: true };
    }

    /**
     * 确保设备记录存在
     */
    ensureDeviceExists(devId) {
        const existing = db.prepare('SELECT id FROM devices WHERE dev_id = ?').get(devId);
        if (!existing) {
            const stmt = db.prepare(`
                INSERT INTO devices (dev_id, status, last_seen_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
            `);
            stmt.run(devId, DEVICE_STATUS.ONLINE);
        }
    }

    /**
     * 更新设备最后在线时间
     */
    updateDeviceLastSeen(devId) {
        const stmt = db.prepare(`
            UPDATE devices 
            SET status = ?, last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE dev_id = ?
        `);
        stmt.run(DEVICE_STATUS.ONLINE, devId);
    }

    /**
     * 更新卡槽信息
     */
    updateSlotInfo(devId, slotInfo) {
        // slotInfo 格式解析 (根据文档格式处理)
        // 具体格式需要根据实际返回数据调整
    }

    /**
     * 检查设备离线状态（定时任务调用）
     * @param {number} timeoutSeconds - 超时秒数
     */
    checkOfflineDevices(timeoutSeconds = 300) {
        const stmt = db.prepare(`
            UPDATE devices 
            SET status = ?
            WHERE status = ? 
            AND last_seen_at < datetime('now', '-' || ? || ' seconds')
        `);
        const result = stmt.run(DEVICE_STATUS.OFFLINE, DEVICE_STATUS.ONLINE, timeoutSeconds);
        
        if (result.changes > 0) {
            console.log(`[System] ${result.changes} 个设备标记为离线`);
        }
    }
}

module.exports = new MessageHandler();
