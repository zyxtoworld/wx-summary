export const PRODUCTION_ROUTE_NAMES = Object.freeze(['digest', 'history', 'settings', 'setup']);

export function createProductionRoutes(loadModule = path => import(path)) {
  if (typeof loadModule !== 'function') throw new TypeError('页面模块加载器无效');
  return Object.fromEntries(PRODUCTION_ROUTE_NAMES.map(name => [name, {
    load: () => loadModule(`./pages/${name}/index.js`),
  }]));
}
