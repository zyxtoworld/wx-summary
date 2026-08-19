function createShowOnce(openNotice) {
  let shown = false;
  let notice;
  return () => {
    if (shown) return notice;
    shown = true;
    try {
      notice = openNotice();
      return notice;
    } catch (error) {
      shown = false;
      notice = undefined;
      throw error;
    }
  };
}

// 致命状态属于整个页面会话，而不是某一个 API 请求。
// 每类提示只允许存在一个；创建失败时释放状态，让后续请求仍可重试展示。
export function createFatalNotices({
  openModal,
  reload = () => location.reload(),
  beforeRestartReload = () => {},
} = {}) {
  if (typeof openModal !== 'function') throw new TypeError('openModal is required');

  const showRestartRequiredNotice = createShowOnce(() => {
    const content = document.createElement('div');
    const p = document.createElement('p');
    p.textContent = '本地代码已发生更改,当前服务尚未重新载入这些更改。请先在任务栏退出并重启本地服务,再点击“我已重启,刷新页面”。';
    const small = document.createElement('p');
    small.className = 'muted';
    small.textContent = '这不是数据库、本地数据或 key 错误。';
    content.append(p, small);
    return openModal({
      title: '本地服务需要重启',
      content,
      dismissible: false,
      actions: [
        {
          label: '我已重启,刷新页面',
          kind: 'primary',
          onClick: () => {
            try { beforeRestartReload(); } catch {}
            reload();
          },
        },
      ],
    });
  });

  const showSessionInvalidNotice = createShowOnce(() => {
    const content = document.createElement('p');
    content.textContent = '本地服务会话已失效(服务可能已重启)。请刷新页面重新建立会话;若地址栏没有启动参数,请从本地启动器重新打开页面。';
    return openModal({
      title: '会话已失效',
      content,
      dismissible: false,
      actions: [
        { label: '刷新页面', kind: 'primary', onClick: () => { reload(); } },
      ],
    });
  });

  return { showRestartRequiredNotice, showSessionInvalidNotice };
}
