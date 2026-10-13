import { describe, expect, it } from 'vitest';
import { localizeError, translate } from './i18n';
describe('bilingual interface messages', () => {
 it('uses exact French and English labels', () => {
  expect(translate('New conversation','fr')).toBe('Nouvelle conversation');
  expect(translate('New conversation','en')).toBe('New conversation');
 });
 it('keeps names and technical data intact in translated templates', () => {
  expect(translate('Last agent: {name}','fr',{name:'ALIEN18'})).toContain('ALIEN18');
  expect(localizeError('ALIEN18: machine is offline.','fr')).toContain('ALIEN18');
 });
 it('switches known native network and token errors in both directions', () => {
  const original='Machine injoignable (vérifiez Tailscale)';
  const english=localizeError(original,'en');
  expect(english).toBe('Machine is unreachable. Check Tailscale.');
  expect(localizeError(english,'fr')).toBe('Machine injoignable. Vérifiez Tailscale.');
  expect(localizeError('Token invalide : format pa_[A-Za-z0-9_-]+ requis, sans espace ni caractère ajouté.','en')).toBe('Invalid token: use pa_[A-Za-z0-9_-]+ without spaces or extra characters.');
 });
 it('leaves unknown remote errors unchanged', () => {
  const text='Remote report: keep @machine: ALIEN18 and /tmp/report.md unchanged.';
  expect(localizeError(text,'fr')).toBe(text);
  expect(localizeError(text,'en')).toBe(text);
 });
 it('uses language plural rules for task counts', () => {
  expect(translate('tasks checked','fr',{checked:1,count:1},1)).toBe('1/1 tâche cochée');
  expect(translate('tasks checked','fr',{checked:1,count:2},2)).toBe('1/2 tâches cochées');
  expect(translate('tasks checked','en',{checked:1,count:1},1)).toBe('1/1 task checked');
  expect(translate('tasks checked','en',{checked:1,count:2},2)).toBe('1/2 tasks checked');
 });
});
