import { formatClock } from '@myciti/shared';

export const clock = (t: number) => formatClock(t, 'Africa/Johannesburg');

export function delayText(sec: number): string {
  const m = Math.round(sec / 60);
  if (m === 0) return 'по расписанию';
  return m > 0 ? `опаздывает на ${m} мин` : `раньше на ${-m} мин`;
}

export function delayShort(sec: number): string {
  const m = Math.round(sec / 60);
  if (m === 0) return '0';
  return m > 0 ? `+${m}` : `−${-m}`;
}

export function ageText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с назад`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин ${s % 60} с назад`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин назад`;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);
