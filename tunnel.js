const { spawn } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

let currentUrl = null;
let pingTimer = null;

function saveTunnelPage(url) {
  try {
    const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>رابط المعاينة الخارجي الحي | مغاسل سحابة</title>
  <style>
    body { font-family: Tahoma, Arial, sans-serif; background: #0f172a; color: #fff; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; text-align:center; }
    .card { background:#1e293b; padding:32px; border-radius:16px; max-width:520px; width:90%; box-shadow:0 15px 35px rgba(0,0,0,0.4); }
    a.btn { display:inline-block; background:#0284c7; color:#fff; text-decoration:none; padding:14px 24px; border-radius:10px; font-weight:bold; font-size:18px; margin:16px 0; word-break:break-all; }
    button { background:#10b981; color:#fff; border:none; padding:10px 20px; border-radius:8px; cursor:pointer; font-size:15px; font-weight:bold; }
  </style>
</head>
<body>
  <div class="card">
    <h2>☁️ رابط المعاينة الخارجي النشط حالياً</h2>
    <p>يتحدث هذا الرابط تلقائياً عند تدوير النفق المجاني:</p>
    <a class="btn" id="liveLink" href="${url}" target="_blank">${url}</a>
    <br/>
    <button onclick="navigator.clipboard.writeText('${url}'); this.innerText='✅ تم نسخ الرابط!';">📋 نسخ الرابط للمشاركة</button>
  </div>
</body>
</html>`;
    fs.writeFileSync(path.join(__dirname, 'public', 'tunnel.html'), html, 'utf8');
  } catch (e) {}
}

function startTunnel() {
  console.log('Starting localhost.run tunnel...');
  const ssh = spawn('C:\\Windows\\System32\\OpenSSH\\ssh.exe', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ExitOnForwardFailure=yes',
    '-R', '80:localhost:3000',
    'nokey@localhost.run'
  ]);

  ssh.stdout.on('data', (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-z0-9]+\.lhr\.life/i);
    if (match && match[0] !== currentUrl) {
      currentUrl = match[0];
      console.log('TUNNEL_URL=' + currentUrl);
      saveTunnelPage(currentUrl);
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (!currentUrl) return;
        https.get(currentUrl + '/api/catalog', (res) => {
          res.resume();
        }).on('error', () => {});
      }, 45000);
    }
  });

  ssh.stderr.on('data', () => {});

  ssh.on('close', (code) => {
    console.log('Tunnel closed with code', code, '- restarting in 3s...');
    if (pingTimer) clearInterval(pingTimer);
    currentUrl = null;
    setTimeout(startTunnel, 3000);
  });
}

startTunnel();
