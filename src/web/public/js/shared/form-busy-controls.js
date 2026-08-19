const disabledBeforeBusy = new WeakMap();

export function syncFormControlsDisabled(controls = [], busy = false) {
  for (const control of controls) {
    if (!control) continue;
    if (busy === true) {
      if (!disabledBeforeBusy.has(control)) {
        disabledBeforeBusy.set(control, control.disabled === true);
      }
      control.disabled = true;
      continue;
    }
    if (!disabledBeforeBusy.has(control)) continue;
    control.disabled = disabledBeforeBusy.get(control);
    disabledBeforeBusy.delete(control);
  }
}
