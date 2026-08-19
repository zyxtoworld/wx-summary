export function restoreSettingsTransientFocus({
  shouldRestore = false,
  owner = null,
  fallback = null,
  activeElement = globalThis.document?.activeElement,
  body = globalThis.document?.body,
  isActive = () => true,
} = {}) {
  if (isActive() === false) return false;
  if (!shouldRestore || !fallback?.isConnected || fallback.disabled === true) return false;
  if (activeElement !== owner && activeElement !== body) return false;
  try {
    fallback.focus({ preventScroll: true });
    return true;
  } catch {
    return false;
  }
}
