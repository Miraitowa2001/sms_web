/**
 * IoT设备 - 消息处理服务
 * 处理各种类型的推送消息
 */

const { dbWrapper: db } = require('./database');
const { getMessageTypeName, getMessageCategory, DEVICE_STATUS, SIM_STATUS } = require('./constants');

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
        // msgTs 是开发板推送消息的时间（北京时间），smsTs 是短信中心返回的时间（可能是其他时区）
        // 优先使用 msgTs，因为它的时区是确定的（开发板设置的北京时间）
        const { devId, slot, phNum, smsBd, smsTs, msgTs, msIsdn } = data;
        
        // 使用 msgTs（开发板推送时间，北京时间），如果没有则用 smsTs
        const timestamp = msgTs || smsTs || Math.floor(Date.now() / 1000);
        
        if (type === 501) {
            // 收到新短信
            console.log(`[SMS] 设备 ${devId} 收到短信, 来自: ${phNum}, msgTs: ${msgTs}, smsTs: ${smsTs}`);
            
            const stmt = db.prepare(`
                INSERT INTO sms_records (dev_id, slot, msisdn, phone_num, content, sms_time, direction)
                VALUES (?, ?, ?, ?, ?, ?, 'in')
            `);
            stmt.run(devId, slot || 1, msIsdn || '', phNum || '', smsBd || '', timestamp);
        } else if (type === 502) {
            // 短信外发成功
            console.log(`[SMS] 设备 ${devId} 短信发送成功, 发送至: ${phNum}, msgTs: ${msgTs}, smsTs: ${smsTs}`);
            
            const stmt = db.prepare(`
                INSERT INTO sms_records (dev_id, slot, msisdn, phone_num, content, sms_time, direction)
                VALUES (?, ?, ?, ?, ?, ?, 'out')
            `);
            stmt.run(devId, slot || 1, msIsdn || '', phNum || '', smsBd || '', timestamp);
        }

        this.ensureDeviceExists(devId);
        this.updateDeviceLastSeen(devId);

        return { success: true };
    }

    /**
     * 处理通话消息 (601-642)
     */
    handleCallMessage(type, data) {
        const { devId, slot, phNum, msIsdn, telStartTs, telEndTs } = data;
        
        console.log(`[Call] 设备 ${devId} ${getMessageTypeName(type)}, 号码: ${phNum}`);

        // 根据消息类型判断通话类型
        let callType = 'incoming';
        if (type >= 620 && type <= 623) {
            callType = 'outgoing';
        }
        if (type === 603) {
            // 未接来电
            const hasAnswered = db.prepare(`
                SELECT id FROM call_records 
                WHERE dev_id = ? AND phone_num = ? AND call_type = 'incoming'
                AND start_time > datetime('now', '-5 minutes')
            `).get(devId, phNum);
            
            if (!hasAnswered) {
                callType = 'missed';
            }
        }

        // 记录通话
        if (type === 603 || type === 623) {
            // 通话结束，记录完整通话记录
            const duration = telEndTs && telStartTs ? telEndTs - telStartTs : 0;
            
            // 开发板推送的时间戳已经是北京时间，直接存储时间戳
            const stmt = db.prepare(`
                INSERT INTO call_records (dev_id, slot, msisdn, phone_num, call_type, start_time, end_time, duration)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run(
                devId, 
                slot || 1, 
                msIsdn || '', 
                phNum || '', 
                callType,
                telStartTs || Math.floor(Date.now() / 1000),
                telEndTs || Math.floor(Date.now() / 1000),
                duration
            );
        }

        this.ensureDeviceExists(devId);
        this.updateDeviceLastSeen(devId);

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
