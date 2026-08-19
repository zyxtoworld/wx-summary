const ACTION_FEEDBACK = Object.freeze({
  copy: Object.freeze({
    busyHint: '正在复制全文…',
    accountSwitchBlocked: '正在复制摘要全文，请等待复制结束后再切换账号。',
    leave: Object.freeze({
      title: '正在复制摘要全文',
      message: '摘要全文正在写入系统剪贴板，离开页面会取消复制。确定离开?',
      confirmLabel: '离开并取消复制',
    }),
  }),
  export: Object.freeze({
    busyHint: '正在导出 Markdown…',
    accountSwitchBlocked: 'Markdown 正在写入本机文件，请等待导出结束后再切换账号。',
    leave: Object.freeze({
      title: 'Markdown 正在导出',
      message: 'Markdown 正在写入本机文件，离开页面会取消导出。确定离开?',
      confirmLabel: '离开并取消导出',
    }),
  }),
  download: Object.freeze({
    busyHint: '正在准备下载…',
    accountSwitchBlocked: '正在准备 Markdown 下载，请等待下载开始后再切换账号。',
    leave: Object.freeze({
      title: '正在准备 Markdown 下载',
      message: 'Markdown 下载正在准备，离开页面会取消下载。确定离开?',
      confirmLabel: '离开并取消下载',
    }),
  }),
  action: Object.freeze({
    busyHint: '正在处理文本预览…',
    accountSwitchBlocked: '文本预览操作正在进行，请等待操作结束后再切换账号。',
    leave: Object.freeze({
      title: '文本预览操作正在进行',
      message: '文本预览操作尚未结束，离开页面会取消当前操作。确定离开?',
      confirmLabel: '离开并取消操作',
    }),
  }),
});

function feedbackFor(kind = '') {
  return ACTION_FEEDBACK[String(kind || '').trim()] || ACTION_FEEDBACK.action;
}

export function textPreviewBusyHint(kind = '') {
  return feedbackFor(kind).busyHint;
}

export function textPreviewAccountSwitchBlockedMessage(kind = '') {
  return feedbackFor(kind).accountSwitchBlocked;
}

export function textPreviewLeaveConfirmation(kind = '') {
  return { ...feedbackFor(kind).leave };
}
