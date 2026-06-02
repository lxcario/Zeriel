// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';

describe('client scaffold', () => {
  it('renders the app shell into the DOM', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    await act(async () => {
      createRoot(container).render(<App />);
    });

    expect(container.textContent).toContain('Glitch');
    container.remove();
  });
});
