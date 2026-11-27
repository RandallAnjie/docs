/**
 * While a menu, popover, dialog or side peek is open, the page behind it does
 * not scroll: wheel and touch scrolling outside the open layer are ignored,
 * and scrolling inside it stops at its edges instead of carrying on to the
 * page. Floating UI positioned against the page therefore never drifts away
 * from what it belongs to.
 */
export const OVERLAY_SELECTOR = [
  '.dialog-backdrop',
  '.app-dialog-backdrop',
  '.workspace-dialog-backdrop',
  '.organization-settings-backdrop',
  '.discovery-backdrop',
  '.public-site-search-backdrop',
  '.database-field-backdrop',
  '.database-record-drawer',
  '.database-date-reminder-backdrop',
  '.mobile-nav-backdrop',
  '.mobile-nav-open .sidebar',
  '.mobile-nav-open .notion-home-sidebar',
  '.floating-layer',
  '.slash-menu',
  '.rdocs-block-menu',
  '.page-action-menu',
  '.header-account-menu',
  '.workspace-menu',
  '.notification-popover',
  '.page-notification-popover',
  '.page-reminder-popover',
  '.rdocs-inline-reminder-popover',
  '.page-tree-menu',
  '.page-backlinks-popover',
  '.database-menu',
  '.database-view-popover',
  '.database-template-menu',
  '.database-view-options',
  '.database-view-menu',
].join(', ');

export interface ScrollBox {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
  overflowX: string;
  overflowY: string;
}

const SCROLLS = new Set(['auto', 'scroll', 'overlay']);

/** Whether one of these boxes (innermost first) can still scroll by the wheel delta. */
export function wheelScrollsWithin(
  boxes: readonly ScrollBox[],
  deltaX: number,
  deltaY: number,
): boolean {
  return boxes.some((box) => {
    if (deltaY !== 0 && SCROLLS.has(box.overflowY) && box.scrollHeight > box.clientHeight + 1) {
      if (
        deltaY < 0 ? box.scrollTop > 0 : box.scrollTop + box.clientHeight < box.scrollHeight - 1
      ) {
        return true;
      }
    }
    if (deltaX !== 0 && SCROLLS.has(box.overflowX) && box.scrollWidth > box.clientWidth + 1) {
      if (
        deltaX < 0 ? box.scrollLeft > 0 : box.scrollLeft + box.clientWidth < box.scrollWidth - 1
      ) {
        return true;
      }
    }
    return false;
  });
}

function scrollBoxes(from: Element, until: Element): ScrollBox[] {
  const boxes: ScrollBox[] = [];
  let node: Element | null = from;
  while (node) {
    const style = window.getComputedStyle(node);
    boxes.push({
      scrollTop: node.scrollTop,
      scrollLeft: node.scrollLeft,
      scrollHeight: node.scrollHeight,
      scrollWidth: node.scrollWidth,
      clientHeight: node.clientHeight,
      clientWidth: node.clientWidth,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
    });
    if (node === until) break;
    node = node.parentElement;
  }
  return boxes;
}

export function installScrollLock(): () => void {
  let locked = false;
  let frame = 0;
  const update = () => {
    frame = 0;
    const next = Boolean(document.querySelector(OVERLAY_SELECTOR));
    if (next === locked) return;
    locked = next;
    document.documentElement.toggleAttribute('data-scroll-locked', next);
  };
  const schedule = () => {
    if (!frame) frame = window.requestAnimationFrame(update);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  update();

  const insideLayer = (target: EventTarget | null): Element | null => {
    if (!(target instanceof Element)) return null;
    return target.closest(OVERLAY_SELECTOR);
  };
  const onWheel = (event: WheelEvent) => {
    if (!locked || event.ctrlKey) return;
    const target = event.target instanceof Element ? event.target : null;
    const layer = insideLayer(target);
    // Backdrops cover the page; scrolling them means scrolling the page.
    const isBackdrop = layer && layer === target && /backdrop/.test(layer.className);
    if (
      layer &&
      target &&
      !isBackdrop &&
      wheelScrollsWithin(scrollBoxes(target, layer), event.deltaX, event.deltaY)
    ) {
      return;
    }
    event.preventDefault();
  };
  const onTouchMove = (event: TouchEvent) => {
    if (!locked) return;
    if (insideLayer(event.target)) return;
    event.preventDefault();
  };
  window.addEventListener('wheel', onWheel, { capture: true, passive: false });
  window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  return () => {
    observer.disconnect();
    if (frame) window.cancelAnimationFrame(frame);
    window.removeEventListener('wheel', onWheel, { capture: true });
    window.removeEventListener('touchmove', onTouchMove, { capture: true });
    document.documentElement.removeAttribute('data-scroll-locked');
  };
}
