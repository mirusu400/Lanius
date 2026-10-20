import { ParseError } from '../i18n/ParseError';
import { generatePayloads, type PayloadMakerConfig } from './payloadMakerModel';

// Purely local work: no engine, plugin execution, or outbound connections.
self.onmessage = (event: MessageEvent<{ config: PayloadMakerConfig; appendTo?: string }>) => {
  try {
    self.postMessage({ text: generatePayloads(event.data.config, event.data.appendTo) });
  } catch (error) {
    self.postMessage({ error: error instanceof ParseError ? error.key : 'payloadMaker.failed' });
  }
};
