import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { SettingsFileDropOverlay } from './SettingsFileDrop';
import { useSettingsFileDrop } from './useSettingsFileDrop';

function Subject({ onFile }: { onFile: (file: File) => void }) {
  const active = useSettingsFileDrop(onFile);
  return <SettingsFileDropOverlay active={active} />;
}

it('accepts a file dropped anywhere in the window and shows an overlay first', () => {
  const onFile = vi.fn();
  const file = new File(['{}'], 'settings.json', { type: 'application/json' });
  const transfer = { types: ['Files'], files: [file], dropEffect: 'none' };
  render(<I18nProvider><Subject onFile={onFile} /></I18nProvider>);

  fireEvent.dragEnter(window, { dataTransfer: transfer });
  expect(screen.getByRole('status')).toBeTruthy();
  fireEvent.drop(window, { dataTransfer: transfer });
  expect(onFile).toHaveBeenCalledWith(file);
  expect(screen.queryByRole('status')).toBeNull();
});
