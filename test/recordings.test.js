const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

async function waitForServer(url, child) {
    for (let attempt = 0; attempt < 50; attempt++) {
        if (child.exitCode !== null) throw new Error(`测试服务提前退出: ${child.exitCode}`);
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('等待测试服务启动超时');
}

test('录音上传、确认、下载和删除完整流程', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-web-recording-'));
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['src/app.js'], {
        cwd: path.resolve(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(port),
            AUTH_ENABLED: 'false',
            API_KEY_ENABLED: 'true',
            API_KEY: 'push-test-key',
            AES_ENABLED: 'false',
            RECORDING_UPLOAD_KEY: 'record-test-key',
            RECORDING_DIR: path.join(tempDir, 'recordings'),
            DATABASE_PATH: path.join(tempDir, 'test.db'),
            LOG_RAW_MESSAGES: 'true'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });

    try {
        await waitForServer(baseUrl, child);

        const uploadPageResponse = await fetch(`${baseUrl}/recordings/upload?key=record-test-key`);
        assert.equal(uploadPageResponse.status, 404);

        const unauthorized = new FormData();
        unauthorized.append('media', new Blob([Buffer.from('#!AMR\n1234')]), 'call_01.amr');
        const unauthorizedResponse = await fetch(`${baseUrl}/recordings/upload`, { method: 'POST', body: unauthorized });
        assert.equal(unauthorizedResponse.status, 401);

        const form = new FormData();
        const amr = Buffer.from('#!AMR\n1234567890');
        form.append('media', new Blob([amr], { type: 'application/octet-stream' }), 'call_01.amr');
        const uploadResponse = await fetch(
            `${baseUrl}/recordings/upload?key=record-test-key&devId=dev001&slot=1&phNum=10086&tid=call-001`,
            { method: 'POST', body: form }
        );
        assert.equal(uploadResponse.status, 200);
        const uploadResult = await uploadResponse.json();
        assert.equal(uploadResult.errcode, 0);
        assert.match(uploadResult.media_id, /call_01\.amr$/);

        let listResult = await fetch(`${baseUrl}/api/recordings`).then(response => response.json());
        assert.equal(listResult.data.length, 1);
        assert.equal(listResult.data[0].status, 'uploaded');
        assert.equal(listResult.data[0].dev_id, 'dev001');
        assert.equal(listResult.data[0].has_file, true);

        const pushResponse = await fetch(`${baseUrl}/push`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': 'push-test-key' },
            body: JSON.stringify({ devId: 'dev001', type: 695, slot: 1, tid: 'call-001', telMediaId: uploadResult.media_id })
        });
        assert.equal(pushResponse.status, 200);

        listResult = await fetch(`${baseUrl}/api/recordings`).then(response => response.json());
        assert.equal(listResult.data[0].status, 'confirmed');

        const download = await fetch(`${baseUrl}${listResult.data[0].download_url}`);
        assert.equal(download.status, 200);
        assert.deepEqual(Buffer.from(await download.arrayBuffer()), amr);

        const deleteResponse = await fetch(`${baseUrl}/api/recordings/${listResult.data[0].id}`, { method: 'DELETE' });
        assert.equal(deleteResponse.status, 200);
        listResult = await fetch(`${baseUrl}/api/recordings`).then(response => response.json());
        assert.equal(listResult.data.length, 0);
    } finally {
        child.kill('SIGTERM');
        await new Promise(resolve => child.once('exit', resolve));
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    assert.equal(stderr, '');
});
