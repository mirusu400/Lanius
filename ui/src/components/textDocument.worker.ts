import { prepareTextDocument, type TextDocumentTask } from './textDocumentModel';

self.onmessage = (event: MessageEvent<TextDocumentTask>) => {
  const result = prepareTextDocument(event.data);
  self.postMessage(result, 'starts' in result ? { transfer: [result.starts.buffer] } : {});
};
