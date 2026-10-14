import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
const source = readFileSync('assets/app.js','utf8');
const start = source.indexOf('  const readOriginalImage =');
const end = source.indexOf('  // 上傳 1~3 張圖片',start);
const read = runInNewContext(source.slice(start,end)+'\nreadOriginalImage', {
  FileReader: class { readAsDataURL(file) { this.result = file.data; this.onload(); } },
  Image: class { set src(value) { this.onload(); } }
});
for (const type of ['image/png','image/jpeg','image/webp','image/gif']) {
  const data = `data:${type};base64,b3JpZ2luYWw=`;
  assert.equal(await read({type,size:1024,data}),data);
}
await assert.rejects(read({type:'image/png',size:5*1024*1024+1}), /5 MB/);
await assert.rejects(read({type:'image/svg+xml',size:100}), /PNG/);
console.log('Passed: original image data preserved for all accepted formats; size and format limits enforced.');
