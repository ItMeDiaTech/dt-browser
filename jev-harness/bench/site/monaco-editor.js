import * as monaco from 'monaco-editor/editor/editor.api.js';

window.MonacoEnvironment = { getWorker: () => new Worker('/monaco-worker.js', { type: 'module' }) };
const key = 'dt-browser-monaco-editor', status = document.querySelector('#status');
let record = null;
try { record = JSON.parse(localStorage.getItem(key)); }
catch { status.textContent = 'Could not restore saved document'; }
// Use Monaco's text model, not its virtualized DOM: https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor_editor_api.editor.ITextModel.html
window.monacoEditor = monaco.editor.create(document.querySelector('#monacoHost'), {
  value: record?.text ?? '', language: 'plaintext', ariaLabel: 'Monaco text input',
  automaticLayout: true, minimap: { enabled: false }, detectIndentation: false,
  insertSpaces: false, trimAutoWhitespace: false, autoIndent: 'none', fontSize: 14,
});
// Keep source-text fidelity deterministic across Windows and Unix hosts.
monacoEditor.getModel().setEOL(monaco.editor.EndOfLineSequence.LF);
if (record) status.textContent = `Saved revision ${record.revision}`;
document.querySelector('#save').onclick = async (event) => {
  const button = event.currentTarget;
  button.disabled = true; status.textContent = 'Saving…';
  const next = { text: monacoEditor.getModel().getValue(), revision: (record?.revision ?? 0) + 1 };
  await new Promise((resolve) => setTimeout(resolve, 120));
  try { localStorage.setItem(key, JSON.stringify(next)); record = next; status.textContent = `Saved revision ${record.revision}`; }
  catch { status.textContent = 'Save failed'; }
  finally { button.disabled = false; }
};
