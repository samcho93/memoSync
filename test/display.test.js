'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fitBounds, resizeBounds, cascadeBounds, MIN_WIDTH, MIN_HEIGHT } = require('../main/display');

const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const left = { workArea: { x: -1280, y: 100, width: 1280, height: 680 } };

test('화면 안의 위치는 그대로 둔다', () => {
  const bounds = { x: 100, y: 100, width: 300, height: 200 };
  assert.deepEqual(fitBounds(bounds, [primary]), bounds);
});

test('보조 모니터에 있던 메모는 그 모니터가 있으면 유지하고 없으면 기본 모니터로 옮긴다', () => {
  const bounds = { x: -900, y: 300, width: 300, height: 200 };
  assert.deepEqual(fitBounds(bounds, [primary, left]), bounds);
  const moved = fitBounds(bounds, [primary]);
  assert.equal(moved.x, 0);
  assert.equal(moved.y, 300);
});

test('상단 바를 잡을 수 없으면 화면 안으로 옮기고 모니터보다 크면 줄인다', () => {
  assert.equal(fitBounds({ x: 100, y: -500, width: 300, height: 200 }, [primary]).y, 0);
  assert.equal(fitBounds({ x: 5000, y: 100, width: 300, height: 200 }, [primary]).x, 1620);
  const huge = fitBounds({ x: 9000, y: 9000, width: 4000, height: 3000 }, [primary]);
  assert.deepEqual(huge, { x: 0, y: 0, width: 1920, height: 1040 });
});

test('일부만 걸쳐도 상단 바를 잡을 수 있으면 사용자 위치를 존중한다', () => {
  const bounds = { x: 1800, y: 900, width: 300, height: 400 };
  assert.deepEqual(fitBounds(bounds, [primary]), bounds);
});

test('크기 조절: 왼쪽·위쪽을 끌면 반대쪽 변이 고정되고 최소 크기를 지킨다', () => {
  const start = { x: 100, y: 100, width: 300, height: 300 };
  assert.deepEqual(resizeBounds(start, 'se', 20, 30), { x: 100, y: 100, width: 320, height: 330 });
  assert.deepEqual(resizeBounds(start, 'nw', 20, 30), { x: 120, y: 130, width: 280, height: 270 });
  const min = resizeBounds(start, 'nw', 1000, 1000);
  assert.equal(min.width, MIN_WIDTH);
  assert.equal(min.height, MIN_HEIGHT);
  assert.equal(min.x + min.width, 400);
  assert.equal(min.y + min.height, 400);
});

test('계단식 기본 위치는 항상 화면 안이다', () => {
  for (let i = 0; i < 20; i += 1) {
    const b = cascadeBounds(i, primary.workArea);
    assert.ok(b.x >= 0 && b.x + b.width <= 1920);
    assert.ok(b.y >= 0 && b.y + b.height <= 1040);
  }
});
