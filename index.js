/**
 * Nezha Agent Loader for Node.js
 * 包含：Matrix 数字雨前台 + 后台自动安装/保活 Agent
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const child_process = require('child_process');
const os = require('os');
const crypto = require('crypto');
const AdmZip = require('adm-zip'); // 需要 npm install adm-zip

// ================= 配置区域 =================
const CONFIG = {
    server: process.env.NZ_SERVER || 'dash.8666669.xyz:443',
    secret: process.env.NZ_CLIENT_SECRET || '2GtO43GHKF8Ic9b9Yy0cnudqXw9Oc9by',
    tls: (process.env.NZ_TLS || 'true').toLowerCase() === 'true',
    port: process.env.PORT || 8080,
    workDir: path.join(__dirname, 'nezha_agent')
};

// 各种文件路径
const FILES = {
    agent: path.join(CONFIG.workDir, 'nezha-agent'),
    config: path.join(CONFIG.workDir, 'config.yml'),
    uuidLock: path.join(CONFIG.workDir, 'uuid.lock'),
    zip: path.join(CONFIG.workDir, 'agent.zip')
};

// ================= 辅助函数 =================

// 1. 获取或生成 UUID
function getOrGenerateUUID() {
    // 优先级 1: 环境变量
    if (process.env.NZ_UUID) {
        console.log(`[System] 使用环境变量提供的 UUID: ${process.env.NZ_UUID}`);
        return process.env.NZ_UUID;
    }

    // 优先级 2: 本地锁文件 (防止重启变号)
    if (fs.existsSync(FILES.uuidLock)) {
        const savedUUID = fs.readFileSync(FILES.uuidLock, 'utf8').trim();
        if (savedUUID) {
            console.log(`[System] 读取到本地保存的 UUID: ${savedUUID}`);
            return savedUUID;
        }
    }

    // 优先级 3: 自动生成新 UUID
    const newUUID = crypto.randomUUID();
    console.log(`[System] 未检测到 UUID，已自动生成: ${newUUID}`);
    
    // 尝试保存到本地
    try {
        if (!fs.existsSync(CONFIG.workDir)) fs.mkdirSync(CONFIG.workDir, { recursive: true });
        fs.writeFileSync(FILES.uuidLock, newUUID);
    } catch (e) {
        console.error(`[Warn] 无法保存 UUID 到本地: ${e.message}`);
    }
    return newUUID;
}

// 2. 检测系统架构
function getArch() {
    const arch = os.arch();
    if (arch === 'x64') return 'amd64';
    if (arch === 'arm64') return 'arm64';
    if (arch === 's390x') return 's390x';
    return 'amd64'; // 默认
}

// 3. 下载文件
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode !== 200 && response.statusCode !== 302) {
                return reject(new Error(`Status Code: ${response.statusCode}`));
            }
            // 处理重定向
            if (response.statusCode === 302) {
                return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

// 4. 生成配置文件
function generateConfig(uuid) {
    const content = `
server: "${CONFIG.server}"
client_secret: "${CONFIG.secret}"
uuid: "${uuid}"
tls: ${CONFIG.tls}
disable_auto_update: true
disable_command_execute: false
report_delay: 1
`;
    fs.writeFileSync(FILES.config, content);
}

// ================= 核心任务 =================

async function startAgent() {
    // 确保目录存在
    if (!fs.existsSync(CONFIG.workDir)) fs.mkdirSync(CONFIG.workDir, { recursive: true });

    // 1. 检查并下载
    if (!fs.existsSync(FILES.agent)) {
        const arch = getArch();
        const url = `https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_${arch}.zip`;
        console.log(`[Installer] 正在下载 Agent (${arch})...`);
        
        try {
            await downloadFile(url, FILES.zip);
            console.log(`[Installer] 下载完成，正在解压...`);
            
            const zip = new AdmZip(FILES.zip);
            zip.extractAllTo(CONFIG.workDir, true);
            
            // 赋予执行权限
            fs.chmodSync(FILES.agent, 0o755);
            fs.unlinkSync(FILES.zip); // 清理 zip
        } catch (e) {
            console.error(`[Error] 安装失败: ${e.message}`);
            return;
        }
    }

    // 2. 配置与启动
    const currentUUID = getOrGenerateUUID();
    generateConfig(currentUUID);

    console.log(`[Agent] 正在启动...`);
    
    // 使用 spawn 启动子进程
    const agent = child_process.spawn(FILES.agent, ['-c', FILES.config], {
        detached: false, // 跟随父进程
        stdio: 'ignore'  // 忽略输出，保持控制台干净
    });

    agent.on('error', (err) => console.error(`[Agent] 启动错误: ${err.message}`));
    agent.on('exit', (code) => console.log(`[Agent] 退出 (Code: ${code})`));
    
    // 防止 Agent 进程过早退出
    agent.unref(); 
}

// ================= 前台 Web 服务 (Matrix Style) =================

const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <title>System Monitor</title>
    <style>
        body { margin: 0; overflow: hidden; background: #000; font-family: 'Courier New', monospace; }
        canvas { display: block; }
        #status {
            position: absolute; top: 50%; left: 50%; 
            transform: translate(-50%, -50%);
            color: #0F0; text-align: center;
            background: rgba(0,0,0,0.8); padding: 20px; border: 1px solid #0F0;
            box-shadow: 0 0 20px #0F0; pointer-events: none;
        }
        h1 { margin: 0; font-size: 2em; text-transform: uppercase; }
        p { margin-top: 10px; opacity: 0.8; }
        .blink { animation: blink 1s infinite; }
        @keyframes blink { 50% { opacity: 0; } }
    </style>
</head>
<body>
    <canvas id="c"></canvas>
    <div id="status">
        <h1>System Online</h1>
        <p>Protocol: Nezha Agent</p>
        <p>Status: <span class="blink">RUNNING</span></p>
    </div>
    <script>
        // Matrix Rain Effect
        var c = document.getElementById("c");
        var ctx = c.getContext("2d");

        c.height = window.innerHeight;
        c.width = window.innerWidth;

        var matrix = "NEZHA AGENT SYSTEM ONLINE 010101 CONNECTING...";
        matrix = matrix.split("");

        var font_size = 14;
        var columns = c.width/font_size; 
        var drops = [];

        for(var x = 0; x < columns; x++)
            drops[x] = 1; 

        function draw() {
            ctx.fillStyle = "rgba(0, 0, 0, 0.04)";
            ctx.fillRect(0, 0, c.width, c.height);

            ctx.fillStyle = "#0F0"; 
            ctx.font = font_size + "px arial";

            for(var i = 0; i < drops.length; i++) {
                var text = matrix[Math.floor(Math.random()*matrix.length)];
                ctx.fillText(text, i*font_size, drops[i]*font_size);

                if(drops[i]*font_size > c.height && Math.random() > 0.975)
                    drops[i] = 0;

                drops[i]++;
            }
        }
        setInterval(draw, 35);
        
        window.onresize = function() {
            c.height = window.innerHeight;
            c.width = window.innerWidth;
        }
    </script>
</body>
</html>
`;

// 启动 HTTP 服务器
http.createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end(htmlContent);
}).listen(CONFIG.port, () => {
    console.log(`[Web] 服务器运行在端口: ${CONFIG.port}`);
    // Web服务器启动后，触发 Agent 安装/启动逻辑
    startAgent();
});
