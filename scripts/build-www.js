// 웹 파일을 www/ 로 복사 (Capacitor가 앱에 넣는 폴더)
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), out = path.join(root, 'www');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'manifest.json', 'icon.svg', 'sw.js']) fs.copyFileSync(path.join(root, f), path.join(out, f));
fs.cpSync(path.join(root, 'vendor'), path.join(out, 'vendor'), { recursive: true });
console.log('www ready:', fs.readdirSync(out).join(', '));
