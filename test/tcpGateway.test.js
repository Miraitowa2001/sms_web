const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { once } = require('events');
const { TcpGateway, FrameDecoder, encodeFrame, FRAME_END } = require('../src/tcpGateway');

test('TCP帧解码兼容半包、粘包和UTF-8内容', () => {
    const decoder = new FrameDecoder();
    const first = encodeFrame({ type: 501, content: '短信内容' });
    const second = encodeFrame({ type: 998 });
    assert.deepEqual(decoder.push(first.subarray(0, 7)), []);
    const frames = decoder.push(Buffer.concat([first.subarray(7), second]));
    assert.equal(frames.length, 2);
    assert.equal(JSON.parse(frames[0]).content, '短信内容');
    assert.equal(JSON.parse(frames[1]).type, 998);
    assert.deepEqual(FRAME_END, Buffer.from([0x11, 0x12]));
});

test('开发板注册后可通过同一TCP连接下发命令并按tid接收应答', async t => {
    const received = [];
    const gateway = new TcpGateway({
        host: '127.0.0.1',
        port: 0,
        commandTimeout: 1000,
        onMessage: async message => {
            received.push(message);
            return message;
        }
    });
    await gateway.start();
    t.after(() => gateway.stop());

    const client = net.createConnection(gateway.address().port, '127.0.0.1');
    await once(client, 'connect');
    t.after(() => client.destroy());

    const clientDecoder = new FrameDecoder();
    const boardFrames = [];
    client.on('data', chunk => {
        for (const frame of clientDecoder.push(chunk)) boardFrames.push(JSON.parse(frame));
    });

    const online = encodeFrame({ devId: 'dev-tcp-001', type: 100, netCh: 0 });
    client.write(online.subarray(0, 9));
    client.write(online.subarray(9));

    await new Promise(resolve => gateway.once('connected', resolve));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(gateway.isConnected('dev-tcp-001'), true);
    assert.equal(boardFrames[0].cmd, 'now');
    assert.match(boardFrames[0].p1, /^\d{14}$/);

    const responsePromise = gateway.sendCommand('dev-tcp-001', 'sendsms', {
        p1: 1, p2: '10086', p3: '查话费', tid: 'sms-tcp-1'
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    const command = boardFrames.find(frame => frame.tid === 'sms-tcp-1');
    assert.deepEqual(command, {
        cmd: 'sendsms', p1: 1, p2: '10086', p3: '查话费', tid: 'sms-tcp-1'
    });

    client.write(encodeFrame({
        devId: 'dev-tcp-001', type: 402, subType: 16, code: 0, tid: 'sms-tcp-1'
    }));
    const response = await responsePromise;
    assert.equal(response.success, true);
    assert.equal(response.transport, 'tcp');
    assert.equal(response.final, true);
    assert.ok(received.some(message => message.type === 402));
});
