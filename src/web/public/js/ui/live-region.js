// 为动态状态节点统一声明可访问播报语义。
export function configureLiveRegion(node, {
  role = 'status',
  politeness = 'polite',
  atomic = true,
} = {}) {
  if (!node?.setAttribute) return node;
  if (role) node.setAttribute('role', role);
  if (politeness) node.setAttribute('aria-live', politeness);
  if (atomic) node.setAttribute('aria-atomic', 'true');
  return node;
}
