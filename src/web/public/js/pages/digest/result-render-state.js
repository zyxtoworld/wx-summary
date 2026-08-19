// 结果画布渲染的局部代次。新渲染开始后，旧渲染只能结束，不能再提交 DOM 或状态。
export function createDigestResultRenderState() {
  let revision = 0;

  return {
    begin() {
      revision += 1;
      return revision;
    },

    current() {
      return revision;
    },

    isCurrent(token) {
      return Number.isInteger(token) && token === revision;
    },

    invalidate() {
      revision += 1;
      return revision;
    },
  };
}
