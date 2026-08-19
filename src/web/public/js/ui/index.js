// UI 原语统一出口:页面通过 ctx.ui 拿到这些。
export { toast, toastSuccess, toastWarn, toastError, syncToastViewportOffset } from './toast.js';
export { openModal, confirmDialog } from './modal.js';
export { spinner, skeletonRows, setGlobalProgress } from './spinner.js';
