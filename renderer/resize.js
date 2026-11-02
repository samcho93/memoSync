'use strict';

// .rz 핸들을 끌면 창 크기를 바꾼다. api는 resizeStart, resizeMove, resizeEnd를 제공한다.
function attachResize(api) {
  for (const handle of document.querySelectorAll('.rz')) {
    let start = null;
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      handle.setPointerCapture(event.pointerId);
      start = { x: event.screenX, y: event.screenY };
      api.resizeStart();
      event.preventDefault();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!start) return;
      api.resizeMove(handle.dataset.edge, event.screenX - start.x, event.screenY - start.y);
    });
    const end = () => {
      if (!start) return;
      start = null;
      api.resizeEnd();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}
