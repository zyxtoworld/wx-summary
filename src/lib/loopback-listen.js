// Windows 对已被系统服务独占或保留的 loopback 端口可能返回 EACCES，
// 而不是通常的 EADDRINUSE。这里只分类“可换候选端口”的监听错误；
// 文件句柄耗尽、地址不可用等错误仍交给调用层失败。
export function isLoopbackPortUnavailableError(error, { platform = process.platform } = {}) {
  const code = String(error?.code || '').trim().toUpperCase();
  return code === 'EADDRINUSE' || (platform === 'win32' && code === 'EACCES');
}
