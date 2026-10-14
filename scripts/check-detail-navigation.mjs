import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';

const source = readFileSync('assets/app.js', 'utf8');
const open = source.slice(source.indexOf('const openProjectDetail ='), source.indexOf('// 送出查看密碼'));
const backStart = source.indexOf('onClick: () => {\n        setViewingProjectId(null);');
assert(backStart >= 0, 'Return action exists');
const back = source.slice(backStart, source.indexOf('\n      className: "detail-back-button', backStart)).replace('onClick:', 'const back =').replace(/,\s*$/, ';');
for (const tab of ['單位成員', '專案列表', '總覽', '找工具・學做法']) {
  let activeTab = tab, activeProject = null, scrollY = 580;
  const context = {
    currentTab: tab, viewingProjectId: null, detailOrigin: {current: null},
    setViewingProjectId: value => { activeProject = value; },
    setCurrentTab: value => { activeTab = value; },
    window: {scrollY, scrollTo: (_, y) => {scrollY = y;}},
    requestAnimationFrame: fn => fn(),
    canViewWithoutPassword: () => false, unlockedIds: [],
    setPwPrompt: () => {}, setPwInput: () => {}, setPwError: () => {}
  };
  runInNewContext(`${open}\n${back}\nopenProjectDetail({id: 'test-project'});`, context);
  assert.equal(activeTab, '專案列表');
  assert.equal(activeProject, 'test-project');
  assert.equal(scrollY, 0);
  runInNewContext('back()', context);
  assert.equal(activeTab, tab);
  assert.equal(activeProject, null);
  assert.equal(scrollY, 580);
  runInNewContext("openProjectDetail({id:'locked',view_password:'test'})", context);
  assert.equal(activeTab, tab, 'Locked project keeps source page until unlocked');
  assert.equal(context.detailOrigin.current.tab, tab);
}
const zoomActions = [...source.matchAll(/setLightboxZoom\(z => (Math\.(?:max|min)\([^\n]+?\))\)/g)];
assert.equal(zoomActions.length, 2);
const [decrease, increase] = zoomActions.map(match => runInNewContext(`z => ${match[1]}`));
assert.equal(decrease(1), 1);
assert.equal(increase(4), 4);
assert.equal(increase(1), 1.5);
assert.equal(decrease(2), 1.5);
console.log('Passed: return to all four origins, scroll restoration, locked-project origin, zoom steps and limits.');
