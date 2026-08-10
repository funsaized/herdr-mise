export function isGlobalEscape(event:Pick<KeyboardEvent,"key">){return event.key==="Escape";}
export function isInteractiveKeyboardTarget(target:EventTarget|null){return target instanceof Element&&Boolean(target.closest("input, select, textarea, button, a[href], [contenteditable='true'], [role='textbox']"));}
