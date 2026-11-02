'use strict';

// 실제 Electron 인스턴스 두 개를 서로 다른 userData와 같은 동기화 폴더로 띄워 완료 기준을 확인한다.
// 실행: npm run test:e2e   (화면에 메모 창이 잠깐 나타난다)
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
const electronPath = require('electron');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.MEMOSYNC_SHOTS || null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`시간 초과: ${label}`);
    await sleep(100);
  }
}

async function launch(userData) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [ROOT, `--user-data=${userData}`],
    env: { ...process.env, MEMOSYNC_E2E: '1' },
    cwd: ROOT,
  });
  await waitFor(() => app.evaluate(() => !!globalThis.memoSyncTest && globalThis.memoSyncTest.notes.status.state !== 'starting'), '앱 시작');
  return app;
}

// 트레이 메뉴의 항목을 라벨로 찾아 실제 click 핸들러를 실행한다.
const clickTray = (app, label) => app.evaluate(({ }, itemLabel) => {
  const item = globalThis.memoSyncTest.trayTemplate().find((entry) => entry.label === itemLabel);
  if (!item) throw new Error(`트레이 항목 없음: ${itemLabel}`);
  // Electron은 체크박스 항목을 뒤집은 뒤 핸들러를 부른다.
  item.click(item.type === 'checkbox' ? { checked: !item.checked } : item);
}, label);

const setFolder = (app, folder) => app.evaluate(async ({ }, f) => {
  await globalThis.memoSyncTest.controller.setSyncFolder(f);
}, folder);

const noteIds = (app) => app.evaluate(() => globalThis.memoSyncTest.windows.ids);

const boundsOf = (app, id) => app.evaluate(({ }, noteId) => globalThis.memoSyncTest.windows.entries.get(noteId).win.getBounds(), id);

const visibleCount = (app) => app.evaluate(() => {
  const { windows } = globalThis.memoSyncTest;
  return [...windows.entries.values()].filter((entry) => entry.win.isVisible()).length;
});

// 메인 프로세스 쪽 창에 표식을 남겨 그 메모의 Playwright 페이지를 찾는다.
async function pageOf(app, id) {
  return waitFor(async () => {
    const marker = await app.evaluate(async ({ }, noteId) => {
      const entry = globalThis.memoSyncTest.windows.entries.get(noteId);
      const value = `memo-${Math.random()}`;
      await entry.win.webContents.executeJavaScript(`window.__marker=${JSON.stringify(value)}`);
      return value;
    }, id);
    for (const page of app.windows()) {
      if (page.url().endsWith('note.html') && await page.evaluate(() => window.__marker) === marker) return page;
    }
    return null;
  }, `메모 창 ${id}`);
}

async function readFolderNote(folder, id) {
  return JSON.parse(await fs.readFile(path.join(folder, `${id}.json`), 'utf8'));
}

async function step(name, fn) {
  const started = Date.now();
  await fn();
  console.log(`  통과  ${name} (${Date.now() - started}ms)`);
}

async function main() {
  const base = await fs.mkdtemp(path.join(process.env.MEMOSYNC_TEST_DIR || os.tmpdir(), 'memosync-e2e-'));
  const userA = path.join(base, 'userA');
  const userB = path.join(base, 'userB');
  const folder = path.join(base, 'cloud');
  await fs.mkdir(folder);
  let a;
  let b;
  try {
    a = await launch(userA);
    b = await launch(userB);
    await setFolder(a, folder);
    await setFolder(b, folder);

    let id;
    let pageA;
    let pageB;

    await step('트레이 "새 메모"로 A에 창 생성 → B에도 창 생성', async () => {
      await clickTray(a, '새 메모');
      const ids = await waitFor(async () => { const v = await noteIds(a); return v.length === 1 && v; }, 'A 창');
      [id] = ids;
      await waitFor(async () => (await noteIds(b)).includes(id), 'B 창');
      const file = await readFolderNote(folder, id);
      assert.equal(file.deleted, false);
      for (const key of ['x', 'y', 'w', 'h', 'alwaysOnTop']) assert.equal(file[key], undefined, `${key}는 기본적으로 동기화되지 않아야 함`);
      pageA = await pageOf(a, id);
      pageB = await pageOf(b, id);
      await waitFor(async () => (await visibleCount(a)) === 1, 'A 창 표시');
    });

    await step('A에서 입력 → 500ms debounce로 저장 → B에 반영', async () => {
      await pageA.locator('#content').click();
      await pageA.keyboard.type('회의 메모 - A에서 작성');
      const before = await readFolderNote(folder, id);
      assert.equal(before.content, '', '입력 직후에는 아직 저장되지 않아야 함');
      await waitFor(async () => (await pageB.locator('#content').inputValue()) === '회의 메모 - A에서 작성', 'B 내용');
      assert.equal((await readFolderNote(folder, id)).content, '회의 메모 - A에서 작성');
    });

    await step('B에서 편집 → A에 반영 (쓰기 루프 없음)', async () => {
      await pageB.locator('#content').fill('B에서 고친 내용');
      await waitFor(async () => (await pageA.locator('#content').inputValue()) === 'B에서 고친 내용', 'A 내용');
      await sleep(800);
      const file = path.join(folder, `${id}.json`);
      const mtime = (await fs.stat(file)).mtimeMs;
      await sleep(1500);
      assert.equal((await fs.stat(file)).mtimeMs, mtime, '안정 후 파일이 다시 쓰이면 안 됨');
    });

    await step('입력 중인 쪽은 원격 변경으로 글자가 덮이지 않는다', async () => {
      await pageA.locator('#content').click();
      await pageA.keyboard.press('End');
      await pageA.keyboard.type('!');
      await pageB.locator('#content').fill('동시에 다른 내용');
      assert.ok((await pageA.locator('#content').inputValue()).endsWith('!'));
      // 수렴: 어느 쪽이 이기든 양쪽 내용이 같아져야 한다.
      await waitFor(async () => {
        const [x, y] = await Promise.all([pageA.locator('#content').inputValue(), pageB.locator('#content').inputValue()]);
        return x === y;
      }, '양쪽 수렴');
    });

    await step('색상·투명도 변경이 B에 반영되고 글자는 불투명하게 유지', async () => {
      await pageA.locator('#btn-style').click();
      await pageA.locator('.swatch[data-swatch="blue"]').click();
      await pageA.locator('#opacity').fill('60');
      await waitFor(async () => {
        const state = await pageB.evaluate(() => ({
          color: document.getElementById('note').dataset.color,
          alpha: getComputedStyle(document.documentElement).getPropertyValue('--note-alpha').trim(),
        }));
        return state.color === 'blue' && Math.abs(Number(state.alpha) - 0.4) < 0.001;
      }, 'B 색상/투명도');
      const file = await readFolderNote(folder, id);
      assert.equal(file.color, 'blue');
      assert.ok(Math.abs(file.opacity - 0.4) < 0.001);
      const ink = await pageB.evaluate(() => getComputedStyle(document.getElementById('content')).color);
      assert.equal(ink, 'rgb(29, 26, 20)');
      await pageA.locator('#btn-style').click();
    });

    await step('글꼴과 글자 크기 변경이 저장되고 B에 반영된다', async () => {
      await pageA.locator('#btn-style').click();
      const installed = await waitFor(async () => {
        const count = await pageA.locator('#font option').count();
        return count > 6 && count;
      }, '설치된 글꼴 목록', 5000).catch(() => 0);
      console.log(`        글꼴 목록 ${await pageA.locator('#font option').count()}개 (설치된 글꼴 읽기 ${installed ? '성공' : '실패, 기본 목록 사용'})`);
      await pageA.locator('#font').selectOption('Consolas');
      await pageA.locator('#font-size').selectOption('20');
      await waitFor(async () => {
        const style = await pageB.evaluate(() => {
          const { fontFamily, fontSize } = getComputedStyle(document.getElementById('content'));
          return { fontFamily, fontSize };
        });
        return style.fontFamily.includes('Consolas') && style.fontSize === '20px';
      }, 'B 글꼴');
      const file = await readFolderNote(folder, id);
      assert.equal(file.font, 'Consolas');
      assert.equal(file.fontSize, 20);
      assert.equal(await pageB.locator('#font').inputValue(), 'Consolas');
      if (SHOTS) {
        await fs.mkdir(SHOTS, { recursive: true });
        await pageA.screenshot({ path: path.join(SHOTS, 'note-font.png'), omitBackground: true });
      }
      await pageA.locator('#btn-style').click();
    });

    await step('항상 위 토글은 이 PC에만 적용된다', async () => {
      await pageA.locator('#btn-top').click();
      await waitFor(() => a.evaluate(({ }, noteId) => globalThis.memoSyncTest.windows.entries.get(noteId).win.isAlwaysOnTop(), id), 'A 항상 위');
      assert.equal(await pageA.locator('#btn-top').getAttribute('aria-pressed'), 'true');
      assert.equal(await b.evaluate(({ }, noteId) => globalThis.memoSyncTest.windows.entries.get(noteId).win.isAlwaysOnTop(), id), false);
    });

    await step('직접 만든 핸들로 크기 조절', async () => {
      const before = await boundsOf(a, id);
      const box = await pageA.locator('.rz-se').boundingBox();
      await pageA.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await pageA.mouse.down();
      await pageA.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30, { steps: 4 });
      await pageA.mouse.up();
      const after = await waitFor(async () => {
        const now = await boundsOf(a, id);
        return now.width > before.width && now;
      }, '크기 변경');
      assert.ok(after.width >= before.width + 30 && after.height >= before.height + 20, JSON.stringify({ before, after }));
    });

    await step('전체 숨기기/표시', async () => {
      await clickTray(a, '전체 숨기기');
      assert.equal(await visibleCount(a), 0);
      await clickTray(a, '전체 표시');
      assert.equal(await visibleCount(a), 1);
    });

    if (SHOTS) {
      await fs.mkdir(SHOTS, { recursive: true });
      await pageA.screenshot({ path: path.join(SHOTS, 'note.png'), omitBackground: true });
    }

    await step('같은 userData로 두 번째 실행 → 즉시 종료(단일 인스턴스)', async () => {
      const code = await new Promise((resolve, reject) => {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(electronPath, [ROOT, `--user-data=${userA}`], { stdio: 'ignore', env });
        const timer = setTimeout(() => { child.kill(); reject(new Error('두 번째 인스턴스가 종료되지 않음')); }, 15000);
        child.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
      });
      assert.equal(code, 0);
      assert.equal((await noteIds(a)).length, 1);
    });

    let savedBounds;
    let savedContent;
    await step('위치 변경 후 재시작하면 메모와 위치가 복원된다', async () => {
      await a.evaluate(({ }, noteId) => {
        globalThis.memoSyncTest.windows.entries.get(noteId).win.setBounds({ x: 137, y: 149, width: 311, height: 287 });
      }, id);
      savedBounds = await boundsOf(a, id);
      await sleep(100);
      savedContent = await pageA.locator('#content').inputValue();
      await a.close();
      const settings = JSON.parse(await fs.readFile(path.join(userA, 'settings.json'), 'utf8'));
      assert.deepEqual(
        { x: settings.layouts[id].x, y: settings.layouts[id].y, width: settings.layouts[id].width, height: settings.layouts[id].height },
        savedBounds,
      );
      a = await launch(userA);
      await waitFor(async () => (await noteIds(a)).includes(id), '재시작 후 창');
      pageA = await pageOf(a, id);
      assert.deepEqual(await boundsOf(a, id), savedBounds);
      assert.equal(await pageA.locator('#content').inputValue(), savedContent);
      assert.equal(await pageA.locator('#btn-top').getAttribute('aria-pressed'), 'true', '항상 위 복원');
    });

    await step('종료 직전의 입력도 저장된다', async () => {
      await pageA.locator('#content').fill('종료 직전 입력');
      await a.close();
      await waitFor(async () => (await readFolderNote(folder, id)).content === '종료 직전 입력', '파일 저장');
      await waitFor(async () => (await pageB.locator('#content').inputValue()) === '종료 직전 입력', 'B 반영');
    });

    await step('A가 꺼진 동안 B의 편집 → A 재시작 시 반영', async () => {
      await pageB.locator('#content').fill('A가 꺼진 동안 편집');
      await waitFor(async () => (await readFolderNote(folder, id)).content === 'A가 꺼진 동안 편집', 'B 저장');
      a = await launch(userA);
      pageA = await pageOf(a, id);
      await waitFor(async () => (await pageA.locator('#content').inputValue()) === 'A가 꺼진 동안 편집', 'A 반영');
    });

    await step('충돌 사본 파일이 나타나면 병합하고 사본을 지운다', async () => {
      const current = await readFolderNote(folder, id);
      const copy = path.join(folder, `${id} (충돌 사본).json`);
      await fs.writeFile(copy, JSON.stringify({ ...current, content: '사본에만 있던 글', updatedAt: current.updatedAt - 1000, deviceId: 'other' }));
      await waitFor(async () => (await pageB.locator('#content').inputValue()).includes('사본에만 있던 글'), 'B 병합');
      await waitFor(async () => (await pageA.locator('#content').inputValue()).includes('사본에만 있던 글'), 'A 병합');
      await waitFor(() => fs.access(copy).then(() => false, () => true), '사본 삭제');
    });

    await step('위치 동기화 옵션을 켜면 위치도 다른 쪽에 반영된다', async () => {
      await a.evaluate(() => globalThis.memoSyncTest.controller.setSyncPosition(true));
      await b.evaluate(() => globalThis.memoSyncTest.controller.setSyncPosition(true));
      await a.evaluate(({ }, noteId) => {
        globalThis.memoSyncTest.windows.entries.get(noteId).win.setBounds({ x: 222, y: 233, width: 300, height: 250 });
      }, id);
      await waitFor(async () => {
        const bounds = await boundsOf(b, id);
        return bounds.x === 222 && bounds.y === 233 && bounds.width === 300 && bounds.height === 250;
      }, 'B 위치');
      const file = await readFolderNote(folder, id);
      assert.equal(file.x, 222);
      assert.equal(file.w, 300);
      // 원격 위치 적용이 다시 쓰기를 부르지 않아야 한다.
      await sleep(1000);
      const mtime = (await fs.stat(path.join(folder, `${id}.json`))).mtimeMs;
      await sleep(1500);
      assert.equal((await fs.stat(path.join(folder, `${id}.json`))).mtimeMs, mtime, '위치 쓰기 루프');

      // 옮긴 직후 저장 전에 다른 PC의 위치가 도착해도 사용자의 이동이 사라지면 안 된다.
      const move = (app, bounds) => app.evaluate(({ }, { noteId, target }) => {
        globalThis.memoSyncTest.windows.entries.get(noteId).win.setBounds(target);
      }, { noteId: id, target: bounds });
      await move(b, { x: 300, y: 310, width: 300, height: 250 });
      await sleep(350);
      await move(a, { x: 340, y: 350, width: 300, height: 250 });
      await waitFor(async () => {
        const [x, y] = await Promise.all([boundsOf(a, id), boundsOf(b, id)]);
        return x.x === 340 && y.x === 340 && x.y === 350 && y.y === 350;
      }, '늦게 옮긴 쪽으로 수렴');

      await a.evaluate(() => globalThis.memoSyncTest.controller.setSyncPosition(false));
      await b.evaluate(() => globalThis.memoSyncTest.controller.setSyncPosition(false));
    });

    await step('저장된 위치가 화면 밖이면 재시작 시 보정된다', async () => {
      await a.close();
      const settingsPath = path.join(userA, 'settings.json');
      const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
      settings.layouts[id] = { ...settings.layouts[id], x: 50000, y: 50000 };
      await fs.writeFile(settingsPath, JSON.stringify(settings));
      a = await launch(userA);
      await waitFor(async () => (await noteIds(a)).includes(id), '창');
      const fitted = await a.evaluate(({ screen }, noteId) => {
        const bounds = globalThis.memoSyncTest.windows.entries.get(noteId).win.getBounds();
        return screen.getAllDisplays().some(({ workArea }) => bounds.x >= workArea.x && bounds.y >= workArea.y
          && bounds.x + bounds.width <= workArea.x + workArea.width && bounds.y + bounds.height <= workArea.y + workArea.height);
      }, id);
      assert.equal(fitted, true);
      pageA = await pageOf(a, id);
    });

    await step('설정 창이 열리고 현재 폴더를 표시한다', async () => {
      await clickTray(a, '설정');
      const page = await waitFor(() => a.windows().find((w) => w.url().endsWith('settings.html')), '설정 창');
      await waitFor(async () => (await page.locator('#folder').textContent()) === path.resolve(folder), '폴더 표시');
      assert.match(await page.locator('#status').textContent(), /정상/);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'settings.png') });
      await page.close();
    });

    await step('메모의 일정이 양쪽 달력에 반영되고 월일은 올해로 들어간다', async () => {
      const calendarOf = (app) => waitFor(() => app.windows().find((w) => w.url().endsWith('calendar.html')), '달력 창');
      const calA = await calendarOf(a);
      const calB = await calendarOf(b);
      const year = new Date().getFullYear();
      const eventsOf = (app) => app.evaluate(() => globalThis.memoSyncTest.calendar.view().events);

      await pageA.locator('#content').fill(`회의 준비\n3월 5일 치과\n${year + 1}년 1월 2일 여행\n버전 1.5 배포`);
      await waitFor(async () => (await eventsOf(b)).length === 2, 'B 일정 2개');
      const events = await eventsOf(b);
      assert.deepEqual(events.map((event) => [event.date, event.title]), [
        [`${year}-03-05`, '치과'],
        [`${year + 1}-01-02`, '여행'],
      ]);
      assert.deepEqual(events[0].noteId, id);

      // 달력을 올해 3월로 옮겨 실제 칸에 표시되는지 본다.
      const showMonth = async (page, targetYear, targetMonth) => {
        for (let i = 0; i < 40; i += 1) {
          const title = await page.locator('#month-title').textContent();
          const [y, m] = title.match(/\d+/g).map(Number);
          const diff = (targetYear - y) * 12 + (targetMonth - m);
          if (diff === 0) return;
          await page.locator(diff > 0 ? '#btn-next' : '#btn-prev').click();
        }
        throw new Error('달력 이동 실패');
      };
      await showMonth(calB, year, 3);
      await waitFor(async () => (await calB.locator(`.cell[data-date="${year}-03-05"] .chip`).textContent()) === '치과', 'B 달력 칸');
      await showMonth(calA, year + 1, 1);
      assert.equal(await calA.locator(`.cell[data-date="${year + 1}-01-02"] .chip`).textContent(), '여행');
      if (SHOTS) await calB.screenshot({ path: path.join(SHOTS, 'calendar.png'), omitBackground: true });

      // 일정을 지우면 달력에서도 사라진다.
      await pageB.locator('#content').fill('회의 준비');
      await waitFor(async () => (await calB.locator(`.cell[data-date="${year}-03-05"] .chip`).count()) === 0, 'B 달력에서 제거');
      await waitFor(async () => (await eventsOf(a)).length === 0, 'A 일정 제거');

      // 일정을 누르면 원본 메모가 나타난다.
      await pageA.locator('#content').fill('3월 5일 치과');
      await waitFor(async () => (await calB.locator(`.cell[data-date="${year}-03-05"] .chip`).count()) === 1, 'B 달력에 다시 표시');
      await clickTray(b, '전체 숨기기');
      assert.equal(await visibleCount(b), 0);
      assert.equal(await b.evaluate(() => globalThis.memoSyncTest.calendar.win.isVisible()), false, '전체 숨기기는 달력도 숨김');
      await clickTray(b, '전체 표시');
      assert.equal(await b.evaluate(() => globalThis.memoSyncTest.calendar.win.isVisible()), true);
      await b.evaluate(({ }, noteId) => globalThis.memoSyncTest.windows.entries.get(noteId).win.hide(), id);
      await calB.locator(`.cell[data-date="${year}-03-05"] .chip`).click();
      await waitFor(async () => (await visibleCount(b)) === 1, '일정 클릭으로 메모 표시');

      // 트레이로 끄고 켤 수 있고, 위치·투명도는 재시작 후에도 유지된다.
      await clickTray(b, '달력 표시');
      await waitFor(() => b.evaluate(() => globalThis.memoSyncTest.calendar.win === null), '달력 꺼짐');
      assert.equal(await b.evaluate(() => globalThis.memoSyncTest.controller.isCalendarEnabled()), false);
      await clickTray(b, '달력 표시');
      await waitFor(() => b.evaluate(() => !!globalThis.memoSyncTest.calendar.win), '달력 켜짐');

      await calA.locator('#btn-style').click();
      await calA.locator('#opacity').fill('55');
      await a.evaluate(() => globalThis.memoSyncTest.calendar.win.setBounds({ x: 60, y: 70, width: 520, height: 500 }));
      await sleep(800);
      await a.close();
      a = await launch(userA);
      const restored = await a.evaluate(() => ({
        bounds: globalThis.memoSyncTest.calendar.win.getBounds(),
        opacity: globalThis.memoSyncTest.calendar.view().opacity,
      }));
      assert.deepEqual(restored.bounds, { x: 60, y: 70, width: 520, height: 500 });
      assert.ok(Math.abs(restored.opacity - 0.45) < 0.001);
      pageA = await pageOf(a, id);
    });

    await step('파일을 끌어다 놓거나 불러오면 다른 쪽에서 열고 저장하고 삭제할 수 있다', async () => {
      pageB = await pageOf(b, id);
      const files = path.join(base, 'files');
      await fs.mkdir(files, { recursive: true });
      const report = path.join(files, '보고서 2026.txt');
      const virus = path.join(files, 'setup.exe');
      await fs.writeFile(report, '공유할 내용');
      await fs.writeFile(virus, 'not really an exe');
      const names = (page) => page.locator('.file-name').allTextContents();

      // 끌어다 놓기: 실제 File 객체를 담은 drop 이벤트를 보낸다.
      await pageA.evaluate(() => {
        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'e2e-drop';
        input.hidden = true;
        document.body.append(input);
      });
      await pageA.locator('#e2e-drop').setInputFiles(report);
      await pageA.evaluate(() => {
        const transfer = new DataTransfer();
        transfer.items.add(document.getElementById('e2e-drop').files[0]);
        const over = new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true });
        document.getElementById('content').dispatchEvent(over);
        if (!over.defaultPrevented || document.getElementById('drop-hint').hidden) throw new Error('드롭 안내가 나타나지 않음');
        document.getElementById('content').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
        document.getElementById('e2e-drop').remove();
      });
      await waitFor(async () => (await names(pageB)).includes('보고서 2026.txt'), 'B에 파일 표시');
      assert.equal(await pageA.locator('#drop-hint').isVisible(), false);
      assert.equal(await pageA.locator('#content').inputValue(), await pageB.locator('#content').inputValue(), '드롭이 본문을 바꾸면 안 됨');
      const stored = path.join(folder, 'attachments', id, '보고서 2026.txt');
      assert.equal(await fs.readFile(stored, 'utf8'), '공유할 내용');
      await fs.access(report);

      // 파일 불러오기: 대화 상자의 결과만 대신하고 나머지는 실제 경로를 탄다.
      const stubDialogs = (app, picked, savePath) => app.evaluate(({ dialog, shell }, { pickedPaths, target }) => {
        globalThis.opened = [];
        globalThis.revealed = [];
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: pickedPaths });
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
        shell.openPath = async (p) => { globalThis.opened.push(p); return ''; };
        shell.showItemInFolder = (p) => { globalThis.revealed.push(p); };
      }, { pickedPaths: picked, target: savePath });
      const saved = path.join(files, '내려받음.txt');
      await stubDialogs(b, [virus, report], saved);
      await pageB.locator('#btn-attach').click();
      await waitFor(async () => (await names(pageA)).length === 3, 'A에 파일 3개');
      assert.deepEqual(await names(pageA), ['보고서 2026 (1).txt', '보고서 2026.txt', 'setup.exe']);

      // 폴더를 고르면 이유를 보여 준다.
      await stubDialogs(b, [files], saved);
      await pageB.locator('#btn-attach').click();
      await waitFor(async () => (await pageB.locator('#file-message').textContent()).includes('폴더는 공유할 수 없습니다'), '폴더 거부 안내');

      // 열기와 저장
      const row = (page, name) => page.locator('.file').filter({ hasText: name });
      await row(pageB, '보고서 2026.txt').locator('.file-open').click();
      await waitFor(() => b.evaluate(() => globalThis.opened.length === 1), '파일 열기');
      assert.equal(await b.evaluate(() => globalThis.opened[0]), path.resolve(stored));
      await row(pageB, '보고서 2026.txt').hover();
      await row(pageB, '보고서 2026.txt').getByRole('button', { name: '다른 이름으로 저장' }).click();
      await waitFor(() => fs.readFile(saved, 'utf8').then((text) => text === '공유할 내용', () => false), '다른 이름으로 저장');

      // 실행 파일은 실행하지 않고 폴더에서 보여 주기만 한다.
      await row(pageB, 'setup.exe').locator('.file-open').click();
      await waitFor(() => b.evaluate(() => globalThis.revealed.length === 1), '폴더에서 보기');
      assert.equal(await b.evaluate(() => globalThis.opened.length), 1, '실행 파일이 열리면 안 됨');
      assert.match(await pageB.locator('#file-message').textContent(), /바로 열지 않고/);

      // 경로 조작은 거부한다.
      const escaped = await pageB.evaluate(() => window.memoNote.openFile('..\\..\\settings.json'));
      assert.ok(escaped.error);
      assert.equal(await b.evaluate(() => globalThis.opened.length), 1);

      // 메모 내용을 고쳐도 파일은 남고, 재시작해도 보인다.
      await pageA.locator('#content').fill('파일이 있는 메모');
      await waitFor(async () => (await pageB.locator('#content').inputValue()) === '파일이 있는 메모', '내용 반영');
      assert.equal((await names(pageB)).length, 3);
      if (SHOTS) {
        await fs.mkdir(SHOTS, { recursive: true });
        await pageB.screenshot({ path: path.join(SHOTS, 'note-files.png'), omitBackground: true });
      }

      // 확인 후 삭제하면 양쪽에서 사라진다. 취소하면 그대로다.
      await row(pageA, 'setup.exe').hover();
      await row(pageA, 'setup.exe').getByRole('button', { name: '삭제' }).click();
      assert.match(await pageA.locator('#confirm-text').textContent(), /setup\.exe/);
      await pageA.locator('#confirm-no').click();
      assert.equal((await names(pageA)).length, 3);
      await row(pageA, 'setup.exe').hover();
      await row(pageA, 'setup.exe').getByRole('button', { name: '삭제' }).click();
      await pageA.locator('#confirm-yes').click();
      await waitFor(async () => (await names(pageB)).length === 2, 'B에서 삭제 반영');
      await assert.rejects(fs.access(path.join(folder, 'attachments', id, 'setup.exe')));

      // 다른 PC에서 파일 폴더만 먼저 도착해도(클라우드 복사) 목록에 나타난다.
      await fs.writeFile(path.join(folder, 'attachments', id, '클라우드에서 도착.txt'), '외부');
      await waitFor(async () => (await names(pageA)).includes('클라우드에서 도착.txt'), '외부 파일 감지');
      await waitFor(async () => (await names(pageB)).includes('클라우드에서 도착.txt'), '외부 파일 감지 B');
    });

    await step('A에서 확인 후 삭제 → 파일은 tombstone, B 창 닫힘', async () => {
      await pageA.locator('#btn-delete').click();
      assert.equal(await pageA.locator('#confirm').isVisible(), true);
      await pageA.locator('#confirm-no').click();
      assert.equal((await noteIds(a)).includes(id), true, '취소하면 유지');
      await pageA.locator('#btn-delete').click();
      await pageA.locator('#confirm-yes').click();
      await waitFor(async () => !(await noteIds(a)).includes(id), 'A 창 닫힘');
      await waitFor(async () => !(await noteIds(b)).includes(id), 'B 창 닫힘');
      const file = await readFolderNote(folder, id);
      assert.equal(file.deleted, true);
      // 공유 파일은 메모를 되살릴 수 있도록 tombstone과 함께 30일간 남는다.
      assert.ok((await fs.readdir(path.join(folder, 'attachments', id))).length > 0);
    });

    await step('삭제된 메모는 재시작해도 돌아오지 않는다', async () => {
      await a.close();
      a = await launch(userA);
      assert.deepEqual(await noteIds(a), []);
      assert.deepEqual(await a.evaluate(() => globalThis.memoSyncTest.calendar.view().events), [], '삭제한 메모의 일정은 사라짐');
    });

    console.log('\nE2E 전체 통과');
  } finally {
    await Promise.allSettled([a && a.close(), b && b.close()]);
    await sleep(300);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((err) => {
  console.error('\nE2E 실패:', err);
  process.exit(1);
});
