let csrf = '';
export const panelCsrf = () => csrf;
export function setPanelCsrf(value: string) {
  csrf = value;
}
export function notifySignedOut() {
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event('mayplane:unauthorized'));
}
