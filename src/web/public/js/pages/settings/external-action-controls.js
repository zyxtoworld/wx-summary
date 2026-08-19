export function createSettingsExternalActionControls() {
  const controls = new Set();
  let busy = false;

  function sync(control) {
    if (control && typeof control === 'object') control.disabled = busy;
  }

  return {
    register(...buttons) {
      for (const button of buttons) {
        if (!button || typeof button !== 'object') continue;
        controls.add(button);
        sync(button);
      }
    },
    setBusy(value) {
      busy = value === true;
      for (const control of controls) sync(control);
    },
    clear() {
      controls.clear();
    },
  };
}
