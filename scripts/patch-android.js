// cap add android 로 생성된 AndroidManifest.xml에 카메라/알림 권한 추가
const fs = require('fs'), p = 'android/app/src/main/AndroidManifest.xml';
let x = fs.readFileSync(p, 'utf8');
const add = [
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
  '<uses-feature android:name="android.hardware.camera" android:required="false" />',
].filter(l => !x.includes(l.match(/android:name="([^"]+)"/)[1])).join('\n    ');
if (add) x = x.replace('</manifest>', '    ' + add + '\n</manifest>');
fs.writeFileSync(p, x);
console.log('manifest patched');
