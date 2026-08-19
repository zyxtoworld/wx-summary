export function makeScrollableRegion(region, {
  label = '滚动内容区域',
  role = 'region',
} = {}) {
  if (!region?.setAttribute) return null;
  region.tabIndex = 0;
  region.setAttribute('role', String(role || 'region'));
  region.setAttribute('aria-label', String(label || '滚动内容区域'));
  return region;
}
