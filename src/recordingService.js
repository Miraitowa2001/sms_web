const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('./config');
const { dbWrapper: db } = require('./database');

const recordingsDir = path.resolve(process.env.RECORDING_DIR || path.join(__dirname, '../data/recordings'));
fs.mkdirSync(recordingsDir, { recursive: true });

function safeName(name) {
    const base = path.basename(String(name || 'recording.amr'));
    return /^[0-9A-Za-z_-]{1,60}\.amr$/.test(base) ? base : 'recording.amr';
}

const storage = multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, recordingsDir),
    filename: (_req, file, callback) => {
        const unique = `${Date.now()}_${crypto.randomBytes(5).toString('hex')}_${safeName(file.originalname)}`;
        callback(null, unique);
    }
});

const upload = multer({
    storage,
    limits: { files: 1, fileSize: config.recordings.maxFileSize },
    fileFilter: (_req, file, callback) => {
        if (!/\.amr$/i.test(file.originalname || '')) return callback(new Error('只允许上传 AMR 录音文件'));
        callback(null, true);
    }
});

function secureEqual(actual, expected) {
    const a = Buffer.from(String(actual || ''));
    const b = Buffer.from(String(expected || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function uploadAuth(req, res, next) {
    const key = req.query.key || req.headers['x-upload-key'];
    if (!secureEqual(key, config.recordings.uploadKey)) {
        return res.status(401).json({ errcode: 401, errmsg: 'Invalid recording upload key', type: '', media_id: '', created_at: 0 });
    }
    next();
}

function isAmr(filePath) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const header = Buffer.alloc(9);
        const length = fs.readSync(fd, header, 0, header.length, 0);
        const value = header.subarray(0, length).toString('ascii');
        return value.startsWith('#!AMR\n') || value.startsWith('#!AMR-WB\n');
    } finally {
        fs.closeSync(fd);
    }
}

function parseInteger(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function receiveUpload(req, res) {
    upload.single('media')(req, res, error => {
        if (error) {
            const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
            return res.status(status).json({ errcode: status, errmsg: error.message, type: '', media_id: '', created_at: 0 });
        }
        if (!req.file) {
            return res.status(400).json({ errcode: 400, errmsg: 'Missing multipart field: media', type: '', media_id: '', created_at: 0 });
        }

        try {
            if (!isAmr(req.file.path)) {
                fs.rmSync(req.file.path, { force: true });
                return res.status(400).json({ errcode: 400, errmsg: 'Invalid AMR file header', type: '', media_id: '', created_at: 0 });
            }

            const mediaId = req.file.filename;
            const insertResult = db.prepare(`
                INSERT INTO recordings (
                    media_id, original_name, stored_name, file_size, dev_id, slot, phone_num, tid,
                    tel_start_ts, tel_connected_ts, tel_end_ts, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded')
            `).run(
                mediaId,
                safeName(req.file.originalname),
                req.file.filename,
                req.file.size,
                String(req.query.devId || ''),
                parseInteger(req.query.slot),
                String(req.query.phNum || req.query.phoneNum || ''),
                String(req.query.tid || ''),
                parseInteger(req.query.telStartTs),
                parseInteger(req.query.telConnectedTs),
                parseInteger(req.query.telEndTs)
            );
            if (insertResult.changes !== 1) throw new Error('录音元数据写入失败');

            return res.json({
                errcode: 0,
                errmsg: 'success',
                type: 'amr',
                media_id: mediaId,
                created_at: Math.floor(Date.now() / 1000)
            });
        } catch (uploadError) {
            if (req.file?.path) fs.rmSync(req.file.path, { force: true });
            console.error('[Recording] 保存录音失败:', uploadError);
            return res.status(500).json({ errcode: 500, errmsg: uploadError.message, type: '', media_id: '', created_at: 0 });
        }
    });
}

function findRecording(id) {
    return db.prepare('SELECT * FROM recordings WHERE id = ?').get(parseInt(id, 10));
}

function filePathFor(recording) {
    if (!recording?.stored_name) return null;
    const resolved = path.resolve(recordingsDir, recording.stored_name);
    return resolved.startsWith(recordingsDir + path.sep) ? resolved : null;
}

function removeRecording(recording) {
    const filePath = filePathFor(recording);
    if (filePath) fs.rmSync(filePath, { force: true });
    return db.prepare('DELETE FROM recordings WHERE id = ?').run(recording.id).changes;
}

function recordResult(data) {
    const type = parseInt(data.type, 10);
    if (![695, 696].includes(type)) return;

    let recording = null;
    if (data.telMediaId) recording = db.prepare('SELECT * FROM recordings WHERE media_id = ? ORDER BY id DESC LIMIT 1').get(data.telMediaId);
    if (!recording && data.tid) recording = db.prepare('SELECT * FROM recordings WHERE tid = ? ORDER BY id DESC LIMIT 1').get(data.tid);

    const status = type === 695 ? 'confirmed' : 'failed';
    const confirmedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
    if (recording) {
        db.prepare(`UPDATE recordings SET status = ?, error_note = ?, confirmed_at = ?,
            dev_id = COALESCE(NULLIF(?, ''), dev_id), slot = COALESCE(?, slot),
            tid = COALESCE(NULLIF(?, ''), tid), media_id = COALESCE(NULLIF(?, ''), media_id)
            WHERE id = ?`).run(status, data.note || '', confirmedAt, data.devId || '', parseInteger(data.slot), data.tid || '', data.telMediaId || '', recording.id);
    } else {
        db.prepare(`INSERT INTO recordings
            (media_id, dev_id, slot, phone_num, tid, tel_start_ts, tel_connected_ts, tel_end_ts, status, error_note, confirmed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(data.telMediaId || '', data.devId || '', parseInteger(data.slot), data.phNum || data.phoneNum || '', data.tid || '',
                parseInteger(data.telStartTs), parseInteger(data.telConnectedTs), parseInteger(data.telEndTs), status, data.note || '', confirmedAt);
    }
}

function deleteByDevice(devId) {
    const rows = db.prepare('SELECT * FROM recordings WHERE dev_id = ?').all(devId);
    for (const row of rows) removeRecording(row);
}

function cleanupExpired() {
    const days = config.recordings.retentionDays;
    if (!days || days <= 0) return 0;
    const threshold = new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    const rows = db.prepare('SELECT * FROM recordings WHERE uploaded_at < ?').all(threshold);
    let deleted = 0;
    for (const row of rows) deleted += removeRecording(row);
    if (deleted) console.log(`[Recording] 自动清理 ${deleted} 条过期录音`);
    return deleted;
}

const router = express.Router();

router.get('/', (req, res) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = (page - 1) * limit;
    const conditions = ['1=1'];
    const params = [];
    for (const [field, column] of [['devId', 'dev_id'], ['status', 'status'], ['slot', 'slot']]) {
        if (req.query[field] !== undefined && req.query[field] !== '') {
            conditions.push(`${column} = ?`);
            params.push(req.query[field]);
        }
    }
    if (req.query.phoneNum) {
        conditions.push('phone_num LIKE ?');
        params.push(`%${req.query.phoneNum}%`);
    }
    const where = conditions.join(' AND ');
    const rows = db.prepare(`SELECT * FROM recordings WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) AS total FROM recordings WHERE ${where}`).get(...params)?.total || 0;
    res.json({
        success: true,
        data: rows.map(row => ({ ...row, has_file: Boolean(filePathFor(row) && fs.existsSync(filePathFor(row))), download_url: `/api/recordings/${row.id}/download` })),
        pagination: { page, limit, total }
    });
});

router.get('/:id/download', (req, res) => {
    const recording = findRecording(req.params.id);
    const filePath = filePathFor(recording);
    if (!recording || !filePath || !fs.existsSync(filePath)) return res.status(404).json({ success: false, error: '录音文件不存在' });
    res.set('Content-Type', 'audio/amr');
    res.set('Content-Disposition', `inline; filename="${safeName(recording.original_name || recording.stored_name)}"`);
    res.sendFile(filePath);
});

router.delete('/:id', (req, res) => {
    const recording = findRecording(req.params.id);
    if (!recording) return res.status(404).json({ success: false, error: '录音记录不存在' });
    removeRecording(recording);
    res.json({ success: true });
});

router.post('/batch-delete', (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) return res.status(400).json({ success: false, error: '请提供要删除的录音ID' });
    let deleted = 0;
    for (const id of ids) {
        const recording = findRecording(id);
        if (recording) deleted += removeRecording(recording);
    }
    res.json({ success: true, deleted });
});

module.exports = { uploadAuth, receiveUpload, router, recordResult, deleteByDevice, cleanupExpired, recordingsDir };
