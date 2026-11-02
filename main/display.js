'use strict';

const MIN_WIDTH = 180;
const MIN_HEIGHT = 120;
const DEFAULT_WIDTH = 260;
const DEFAULT_HEIGHT = 240;
// 이만큼 화면 안에 보여야 상단 바를 잡아 옮길 수 있다.
const MIN_VISIBLE_W = 80;
const MIN_VISIBLE_H = 28;

function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { w: Math.max(0, w), h: Math.max(0, h) };
}

// 상단 바가 어느 모니터에서도 잡히지 않으면 가장 가까운 모니터 안으로 옮긴다.
// displays는 [{ workArea: {x, y, width, height} }] 형태이며 첫 항목이 기본 모니터다.
function fitBounds(bounds, displays) {
  const fitted = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(MIN_WIDTH, Math.round(bounds.width)),
    height: Math.max(MIN_HEIGHT, Math.round(bounds.height)),
  };
  const titleBar = { ...fitted, height: MIN_VISIBLE_H };
  const reachable = displays.some(({ workArea }) => {
    const { w, h } = overlap(titleBar, workArea);
    return w >= MIN_VISIBLE_W && h >= MIN_VISIBLE_H;
  });
  if (reachable) return fitted;

  const centerX = fitted.x + fitted.width / 2;
  const centerY = fitted.y + fitted.height / 2;
  let nearest = displays[0].workArea;
  let best = Infinity;
  for (const { workArea } of displays) {
    const dx = centerX - Math.max(workArea.x, Math.min(centerX, workArea.x + workArea.width));
    const dy = centerY - Math.max(workArea.y, Math.min(centerY, workArea.y + workArea.height));
    const distance = dx * dx + dy * dy;
    if (distance < best) {
      best = distance;
      nearest = workArea;
    }
  }
  const width = Math.min(fitted.width, nearest.width);
  const height = Math.min(fitted.height, nearest.height);
  return {
    x: Math.max(nearest.x, Math.min(fitted.x, nearest.x + nearest.width - width)),
    y: Math.max(nearest.y, Math.min(fitted.y, nearest.y + nearest.height - height)),
    width,
    height,
  };
}

// 메모가 겹치지 않도록 계단식으로 기본 위치를 정한다.
function cascadeBounds(index, workArea) {
  const step = index % 8;
  return fitBounds({
    x: workArea.x + workArea.width - DEFAULT_WIDTH - 80 - step * 28,
    y: workArea.y + 60 + step * 28,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  }, [{ workArea }]);
}

// 왼쪽·위쪽 가장자리를 끌 때는 반대쪽 변이 고정되도록 위치도 함께 옮긴다.
function resizeBounds(start, edge, dx, dy) {
  let { x, y, width, height } = start;
  if (edge.includes('e')) width = Math.max(MIN_WIDTH, start.width + dx);
  if (edge.includes('s')) height = Math.max(MIN_HEIGHT, start.height + dy);
  if (edge.includes('w')) {
    width = Math.max(MIN_WIDTH, start.width - dx);
    x = start.x + start.width - width;
  }
  if (edge.includes('n')) {
    height = Math.max(MIN_HEIGHT, start.height - dy);
    y = start.y + start.height - height;
  }
  return { x, y, width, height };
}

module.exports = { MIN_WIDTH, MIN_HEIGHT, fitBounds, cascadeBounds, resizeBounds };
