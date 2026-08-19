import assert from 'node:assert/strict';

const { __llmInternals } = await import('../src/summarizer/llm.js');

async function runScenario(mode) {
  const controller = new AbortController();
  const url = `http://127.0.0.1/late-${mode}`;
  let fetchCalled = false;
  let resolveFetch;
  let resolveBodyCancel;
  let resolveBodyCancelStarted;
  let bodyCancelCalls = 0;
  const fetchDeferred = new Promise(resolve => { resolveFetch = resolve; });
  const bodyCancelStarted = new Promise(resolve => { resolveBodyCancelStarted = resolve; });
  const bodyCancelPending = new Promise(resolve => { resolveBodyCancel = resolve; });
  const unhandledRejections = [];
  const onUnhandledRejection = reason => unhandledRejections.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const pending = __llmInternals.enrichMessagesWithLinkPreviews(
      [{ time: '09:00', sender: '测试', type: 'text', content: url }],
      {
        enabled: true,
        allow_private_networks: true,
        max_related_links: 0,
        _fetch: async () => {
          fetchCalled = true;
          return fetchDeferred;
        },
      },
      null,
      controller.signal,
    );

    for (let attempt = 0; attempt < 10 && !fetchCalled; attempt += 1) await Promise.resolve();
    assert.equal(fetchCalled, true, `${mode}: link preview must reach the injected fetch boundary`);

    const cancellation = Object.assign(new Error(`预览请求已取消：${mode}`), { name: 'AbortError', status: 499 });
    controller.abort(cancellation);
    let settled = false;
    const observed = pending.then(
      value => { settled = true; return { value }; },
      error => { settled = true; return { error }; },
    );
    resolveFetch({
      ok: true,
      status: 200,
      url,
      headers: { get() { return 'text/html'; } },
      body: {
        cancel() {
          bodyCancelCalls += 1;
          resolveBodyCancelStarted();
          if (mode === 'throw') throw new Error('同步取消失败');
          if (mode === 'reject') return Promise.reject(new Error('异步取消失败'));
          return bodyCancelPending;
        },
      },
      async text() {
        return '<html><title>late</title></html>';
      },
    });

    await bodyCancelStarted;
    for (let attempt = 0; attempt < 20 && !settled; attempt += 1) await Promise.resolve();
    assert.equal(settled, true, `${mode}: abort must not wait for body cancel to settle`);
    const outcome = await observed;
    assert.equal(outcome.error, cancellation, `${mode}: caller cancellation identity must be preserved`);
    assert.equal(outcome.error.status, 499, `${mode}: caller cancellation status must be preserved`);
    assert.equal(bodyCancelCalls, 1, `${mode}: stale response body must be cancelled exactly once`);

    if (mode === 'never') resolveBodyCancel();
    for (let attempt = 0; attempt < 5; attempt += 1) await Promise.resolve();
    assert.deepEqual(unhandledRejections, [], `${mode}: body cancellation failure must be handled`);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
}

for (const mode of ['throw', 'reject', 'never']) await runScenario(mode);

console.log('llm link preview late fetch abort tests passed');
