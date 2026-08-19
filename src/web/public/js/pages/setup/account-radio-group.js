const RADIO_SELECTOR = '[role="radio"]';

export function setupAccountRadioNavigationIndex(key, currentIndex, count) {
  const size = Math.max(0, Number(count) || 0);
  if (!size) return -1;
  const current = Math.max(0, Math.min(size - 1, Number(currentIndex) || 0));
  if (key === 'ArrowDown' || key === 'ArrowRight') return (current + 1) % size;
  if (key === 'ArrowUp' || key === 'ArrowLeft') return (current - 1 + size) % size;
  if (key === 'Home') return 0;
  if (key === 'End') return size - 1;
  return -1;
}

export function configureSetupAccountRadioGroup(group, {
  label = '选择微信账号',
} = {}) {
  if (!group?.querySelectorAll || !group?.addEventListener) {
    throw new Error('账号单选组需要可交互容器');
  }
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', label);

  const options = () => [...group.querySelectorAll(RADIO_SELECTOR)];
  const syncTabStops = () => {
    const items = options();
    const target = items.find(option => option.disabled !== true && option.getAttribute('aria-checked') === 'true')
      || items.find(option => option.disabled !== true)
      || null;
    for (const option of items) option.tabIndex = option === target ? 0 : -1;
    return target;
  };
  const onKeydown = event => {
    const items = options();
    if (!items.length) return;
    const eventOption = event.target?.closest?.(RADIO_SELECTOR) || event.target;
    const selectedIndex = items.findIndex(option => option.getAttribute('aria-checked') === 'true');
    const eventIndex = items.indexOf(eventOption);
    const currentIndex = eventIndex >= 0 ? eventIndex : Math.max(0, selectedIndex);
    const nextIndex = setupAccountRadioNavigationIndex(event.key, currentIndex, items.length);
    if (nextIndex < 0) return;
    const next = items[nextIndex];
    if (!next || next.disabled === true) return;
    event.preventDefault();
    next.focus({ preventScroll: false });
    next.click();
  };

  group.addEventListener('keydown', onKeydown);
  return {
    syncTabStops,
    destroy() {
      group.removeEventListener?.('keydown', onKeydown);
    },
  };
}
