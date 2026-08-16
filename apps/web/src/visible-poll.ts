export function startVisibleInterval(tick: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setInterval> | 0 = 0;
  const run = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') tick();
  };
  const arm = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(run, ms);
  };
  const onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      if (timer) clearInterval(timer);
      timer = 0;
      return;
    }
    run();
    arm();
  };
  arm();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }
  return () => {
    if (timer) clearInterval(timer);
    timer = 0;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}
