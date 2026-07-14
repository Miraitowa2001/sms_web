const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const FRAME_END = Buffer.from([0x11, 0x12]);

function encodeFrame(payload) {
    return Buffer.concat([Buffer.from(JSON.stringify(payload), 'utf8'), FRAME_END]);
}

function formatDeviceTime(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).reduce((result, part) => {
        result[part.type] = part.value;
        return result;
    }, {});
    return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`;
}

class FrameDecoder {
    constructor(maxFrameSize = 1024 * 1024) {
        this.maxFrameSize = maxFrameSize;
        this.buffer = Buffer.alloc(0);
    }

    push(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (this.buffer.length > this.maxFrameSize && this.buffer.indexOf(FRAME_END) === -1) {
            throw new Error(`TCP帧超过限制 ${this.maxFrameSize} 字节`);
        }

        const frames = [];
        let index;
        while ((index = this.buffer.indexOf(FRAME_END)) !== -1) {
            const frame = this.buffer.subarray(0, index);
            this.buffer = this.buffer.subarray(index + FRAME_END.length);
            if (frame.length > this.maxFrameSize) throw new Error(`TCP帧超过限制 ${this.maxFrameSize} 字节`);
            if (frame.length) frames.push(frame.toString('utf8'));
        }
        return frames;
    }
}

class TcpGateway extends EventEmitter {
    constructor(options = {}) {
        super();
        this.host = options.host || '0.0.0.0';
        this.port = Number(options.port ?? 6888);
        this.commandTimeout = Number(options.commandTimeout ?? 10000);
        this.handshakeTimeout = Number(options.handshakeTimeout ?? 5000);
        this.maxFrameSize = Number(options.maxFrameSize ?? 1024 * 1024);
        this.onMessage = options.onMessage || (async message => message);
        this.encodeMessage = options.encodeMessage || (message => message);
        this.server = null;
        this.connections = new Map();
        this.pending = new Map();
        this.sequence = 0;
    }

    async start() {
        if (this.server) return this.address();
        this.server = net.createServer(socket => this.handleConnection(socket));
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.port, this.host, () => {
                this.server.off('error', reject);
                resolve();
            });
        });
        return this.address();
    }

    configure(options = {}) {
        if (this.server) throw new Error('TCP网关启动后不能重新配置');
        if (options.host !== undefined) this.host = options.host;
        if (options.port !== undefined) this.port = Number(options.port);
        if (options.commandTimeout !== undefined) this.commandTimeout = Number(options.commandTimeout);
        if (options.handshakeTimeout !== undefined) this.handshakeTimeout = Number(options.handshakeTimeout);
        if (options.maxFrameSize !== undefined) this.maxFrameSize = Number(options.maxFrameSize);
        if (options.onMessage !== undefined) this.onMessage = options.onMessage;
        if (options.encodeMessage !== undefined) this.encodeMessage = options.encodeMessage;
    }

    async stop() {
        for (const connection of this.connections.values()) connection.socket.destroy();
        this.connections.clear();
        for (const [tid, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error('TCP网关已停止'));
            this.pending.delete(tid);
        }
        if (!this.server) return;
        const server = this.server;
        this.server = null;
        await new Promise(resolve => server.close(resolve));
    }

    address() {
        return this.server ? this.server.address() : null;
    }

    handleConnection(socket) {
        const decoder = new FrameDecoder(this.maxFrameSize);
        const connection = {
            socket,
            devId: null,
            remoteAddress: socket.remoteAddress,
            remotePort: socket.remotePort,
            connectedAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            netCh: null,
            handshakeComplete: false,
            processing: Promise.resolve()
        };

        socket.setKeepAlive(true, 30000);
        socket.setNoDelay(true);
        const handshakeTimer = setTimeout(() => {
            if (!connection.handshakeComplete) socket.destroy(new Error('TCP握手超时'));
        }, this.handshakeTimeout);

        socket.on('data', chunk => {
            try {
                for (const frame of decoder.push(chunk)) {
                    connection.processing = connection.processing
                        .then(() => this.handleFrame(connection, frame))
                        .catch(error => {
                            this.emit('clientError', error, this.publicConnection(connection));
                            socket.destroy();
                        });
                }
            } catch (error) {
                this.emit('clientError', error, this.publicConnection(connection));
                socket.destroy();
            }
        });
        socket.on('error', error => this.emit('clientError', error, this.publicConnection(connection)));
        socket.on('close', () => {
            clearTimeout(handshakeTimer);
            if (connection.devId && this.connections.get(connection.devId)?.socket === socket) {
                this.connections.delete(connection.devId);
                this.rejectPendingForDevice(connection.devId, '设备TCP连接已断开');
                this.emit('disconnected', this.publicConnection(connection));
            }
        });
    }

    async handleFrame(connection, rawFrame) {
        let parsed;
        try {
            parsed = JSON.parse(rawFrame);
        } catch (error) {
            throw new Error(`无效的TCP JSON数据: ${error.message}`);
        }

        const message = await this.onMessage(parsed, this.publicConnection(connection));
        if (!message || typeof message !== 'object') return;
        connection.lastSeenAt = new Date().toISOString();
        connection.netCh = message.netCh ?? connection.netCh;

        if (message.devId) this.registerConnection(String(message.devId), connection);

        if ([100, 101, 102].includes(Number(message.type))) {
            if (!connection.devId) throw new Error('联网消息缺少devId');
            const tid = `init-${connection.devId}-${Date.now()}`;
            connection.socket.write(encodeFrame(this.encodeMessage({ cmd: 'now', p1: formatDeviceTime(), tid })));
            connection.handshakeComplete = true;
        } else if (connection.devId) {
            connection.handshakeComplete = true;
        }

        this.resolvePending(message, connection);
        this.emit('message', message, this.publicConnection(connection));
    }

    registerConnection(devId, connection) {
        const previous = this.connections.get(devId);
        if (previous && previous.socket !== connection.socket) previous.socket.destroy();
        const isNewRegistration = connection.devId !== devId || previous?.socket !== connection.socket;
        connection.devId = devId;
        this.connections.set(devId, connection);
        if (isNewRegistration) this.emit('connected', this.publicConnection(connection));
    }

    isConnected(devId) {
        const connection = this.connections.get(String(devId));
        return Boolean(connection && !connection.socket.destroyed && connection.socket.writable);
    }

    listConnections() {
        return [...this.connections.values()].map(connection => this.publicConnection(connection));
    }

    publicConnection(connection) {
        return {
            devId: connection.devId,
            remoteAddress: connection.remoteAddress,
            remotePort: connection.remotePort,
            connectedAt: connection.connectedAt,
            lastSeenAt: connection.lastSeenAt,
            netCh: connection.netCh,
            handshakeComplete: connection.handshakeComplete
        };
    }

    nextTid(devId) {
        this.sequence = (this.sequence + 1) % 1000000;
        return `${String(devId).slice(-12)}-${Date.now()}-${this.sequence}-${crypto.randomBytes(2).toString('hex')}`;
    }

    sendCommand(devId, command, params = {}, options = {}) {
        const id = String(devId);
        const connection = this.connections.get(id);
        if (!this.isConnected(id)) return Promise.reject(new Error(`设备 ${id} 没有可用的TCP连接`));

        const tid = String(params.tid || options.tid || this.nextTid(id));
        if (this.pending.has(tid)) return Promise.reject(new Error(`tid ${tid} 已有等待中的命令`));
        const payload = { cmd: command, ...params, tid };
        const timeout = Number(options.timeout ?? this.commandTimeout);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(tid);
                reject(new Error(`等待设备 ${id} 的命令应答超时`));
            }, timeout);
            this.pending.set(tid, { devId: id, command, resolve, reject, timer, sentAt: Date.now() });
            connection.socket.write(encodeFrame(this.encodeMessage(payload)), error => {
                if (!error) return;
                clearTimeout(timer);
                this.pending.delete(tid);
                reject(error);
            });
        });
    }

    resolvePending(message, connection) {
        if (!message.tid) return;
        const pending = this.pending.get(String(message.tid));
        if (!pending || pending.devId !== connection.devId) return;
        const type = Number(message.type);
        if (![401, 402].includes(type) && message.code === undefined) return;

        clearTimeout(pending.timer);
        this.pending.delete(String(message.tid));
        const code = Number(message.code ?? 0);
        pending.resolve({
            success: code === 0,
            transport: 'tcp',
            accepted: type === 401 && code === 0,
            final: type === 402,
            data: message,
            command: { cmd: pending.command, tid: String(message.tid) },
            elapsedMs: Date.now() - pending.sentAt
        });
    }

    rejectPendingForDevice(devId, reason) {
        for (const [tid, pending] of this.pending) {
            if (pending.devId !== devId) continue;
            clearTimeout(pending.timer);
            pending.reject(new Error(reason));
            this.pending.delete(tid);
        }
    }
}

const gateway = new TcpGateway();

module.exports = gateway;
module.exports.TcpGateway = TcpGateway;
module.exports.FrameDecoder = FrameDecoder;
module.exports.encodeFrame = encodeFrame;
module.exports.FRAME_END = FRAME_END;
module.exports.formatDeviceTime = formatDeviceTime;
