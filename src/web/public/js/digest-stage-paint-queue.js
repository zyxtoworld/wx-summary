export function digestServerWaitPulseShouldYield(stage = {}) {
  const phase = String(stage?.phase || '').trim().toLowerCase();
  if (!phase || phase === 'fetch_wait' || phase === 'llm_wait') return false;
  return true;
}

export function createSerializedStagePaintQueue({
  signal = null,
  onStage = null,
  barrierKeyForStage = () => '',
  shouldSkipStage = () => false,
  waitForPreviousBarrier = async () => true,
  waitForPaint = async () => {},
  reportError = () => {},
  now = () => Date.now(),
} = {}) {
  let tail = Promise.resolve();
  let lastPaintBarrierKey = '';
  let lastBarrierPaintAt = 0;

  const report = error => {
    try {
      reportError(error);
    } catch (reportFailure) {
      console.error('digest stage paint error reporter failed', reportFailure, error);
    }
  };
  const enqueue = (stage = {}) => {
    tail = tail.then(async () => {
      if (signal?.aborted) return;
      const barrierKey = String(barrierKeyForStage(stage) || '');
      if (shouldSkipStage(stage)) {
        if (!barrierKey) lastPaintBarrierKey = '';
        return;
      }
      const needsPaintBarrier = !!barrierKey && barrierKey !== lastPaintBarrierKey;
      if (needsPaintBarrier && !(await waitForPreviousBarrier(lastBarrierPaintAt, signal))) return;
      if (signal?.aborted || typeof onStage !== 'function') return;
      await onStage(stage);
      if (signal?.aborted) return;
      if (barrierKey) {
        lastPaintBarrierKey = barrierKey;
        if (needsPaintBarrier) {
          await waitForPaint();
          lastBarrierPaintAt = now();
        }
      } else {
        lastPaintBarrierKey = '';
      }
    }).catch(report);
    // Presentation timing must never block SSE consumption.
    return Promise.resolve();
  };

  return {
    enqueue,
    flush: () => tail.catch(report),
  };
}
