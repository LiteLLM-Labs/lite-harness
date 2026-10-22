import {element} from './ui.js';

export class ChangesView {
  constructor(root, api) {
    this.root = root;
    this.api = api;
    this.run = null;
    this.data = null;
    this.selectedPath = null;
    this.visible = false;
    this.loading = false;
    this.revision = 0;
    this.timer = null;
    this.error = '';
    this.renderSignature = '';
  }

  update(run, visible) {
    this.visible = visible;
    if (!visible) { clearTimeout(this.timer); this.timer = null; return; }
    const changed = this.run?.id !== run?.id;
    const ended = this.run?.status === 'running' && run?.status !== 'running';
    this.run = run;
    if (changed) {
      this.revision += 1;
      this.data = null;
      this.selectedPath = null;
      this.loading = false;
      this.error = '';
    }
    if (!run) { this.render(); return; }
    if (changed || ended || !this.data && !this.loading && !this.error) this.refresh();
    else if (!this.loading && !this.timer && !this.data?.frozen && (this.data?.available !== false || this.data?.pending)) this.schedule();
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; if (this.visible) this.refresh(); }, 5000);
  }

  async refresh() {
    if (!this.run || this.loading) return;
    clearTimeout(this.timer);
    this.timer = null;
    const revision = ++this.revision;
    const runId = this.run.id;
    this.loading = true;
    this.error = '';
    this.render();
    try {
      const data = await this.api(`/api/changes?runId=${encodeURIComponent(runId)}`);
      if (revision !== this.revision) return;
      this.data = data;
      if (!data.files?.some((file) => file.path === this.selectedPath)) this.selectedPath = data.files?.[0]?.path || null;
    } catch (error) {
      if (revision !== this.revision) return;
      this.error = error.status === 404 ? 'Changes are not available from this server yet.' : error.message;
    } finally {
      if (revision === this.revision) {
        this.loading = false;
        this.render();
        if (this.visible && !this.error && (this.data?.available !== false || this.data?.pending) && !this.data?.frozen) this.schedule();
      }
    }
  }

  render() {
    const signature = JSON.stringify([this.run?.id, this.selectedPath, this.data?.files, this.data?.available, this.data?.pending, this.data?.frozen, this.data?.truncated, this.data?.reason, this.error, !this.data && this.loading]);
    if (signature === this.renderSignature) {
      const refresh = this.root.querySelector('.changes-refresh');
      if (refresh) { refresh.disabled = this.loading || !this.run; refresh.textContent = this.loading ? 'Checking…' : 'Refresh ↻'; }
      const updated = this.root.querySelector('.changes-updated');
      if (updated && this.data?.comparedAt) updated.textContent = new Date(this.data.comparedAt).toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'});
      return;
    }
    this.renderSignature = signature;
    const heading = element('div', 'changes-heading');
    const title = element('div');
    title.append(element('h2', '', 'Changes'), element('p', '', this.data?.frozen ? 'Final snapshot of this work period' : 'Since this work period began'));
    const refresh = element('button', 'quiet-button changes-refresh', this.loading ? 'Checking…' : 'Refresh ↻');
    refresh.disabled = this.loading || !this.run;
    refresh.addEventListener('click', () => this.refresh());
    heading.append(title, refresh);
    const elements = [heading];
    if (!this.run) elements.push(element('p', 'group-empty', 'Start a conversation to track its project changes.'));
    else if (this.error) elements.push(element('p', 'changes-notice', this.error));
    else if (this.data?.available === false) elements.push(element('p', 'changes-notice', this.data.pending ? 'Preparing the project baseline…' : this.data.reason || 'This saved work period has no change baseline. New work periods will track changes.'));
    else if (!this.data) elements.push(element('p', 'group-empty', 'Reading project changes…'));
    else {
      const files = this.data.files || [];
      const additions = files.reduce((sum, file) => sum + (Number(file.additions) || 0), 0);
      const deletions = files.reduce((sum, file) => sum + (Number(file.deletions) || 0), 0);
      const countsKnown = files.every((file) => Number.isInteger(file.additions) && Number.isInteger(file.deletions));
      const summary = element('div', 'changes-summary');
      summary.append(element('span', '', `${files.length} ${files.length === 1 ? 'file' : 'files'}`));
      if (countsKnown) summary.append(element('span', 'diff-add-count', `+${additions}`), element('span', 'diff-delete-count', `−${deletions}`));
      else summary.append(element('span', '', 'Line counts unavailable'));
      if (this.data.comparedAt) summary.append(element('span', 'changes-updated', new Date(this.data.comparedAt).toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'})));
      elements.push(summary, element('p', 'changes-scope', 'Observed project changes can include your edits and other active swarms.'));
      if (this.data.truncated) elements.push(element('p', 'changes-notice', 'This is a bounded preview. Some large changes are omitted.'));
      if (!files.length) elements.push(element('p', 'group-empty', 'No tracked text files changed during this work period.'));
      else {
        const layout = element('div', 'changes-layout');
        const list = element('nav', 'changed-files');
        list.setAttribute('aria-label', 'Changed files');
        for (const file of files) {
          const button = element('button', `changed-file${file.path === this.selectedPath ? ' selected' : ''}`);
          button.setAttribute('aria-pressed', String(file.path === this.selectedPath));
          button.title = file.path;
          const counts = Number.isInteger(file.additions) && Number.isInteger(file.deletions) ? `+${file.additions} −${file.deletions}` : '—';
          button.append(element('span', `file-status ${file.status}`, {added: 'A', modified: 'M', deleted: 'D'}[file.status] || 'M'), element('span', 'changed-file-path', file.path), element('span', 'file-counts', counts));
          button.addEventListener('click', () => { this.selectedPath = file.path; this.render(); });
          list.append(button);
        }
        layout.append(list, this.diff(files.find((file) => file.path === this.selectedPath) || files[0]));
        elements.push(layout);
      }
    }
    const previous = this.root.querySelector('.diff-code');
    const scroll = previous?.scrollTop || 0;
    const scrollLeft = previous?.scrollLeft || 0;
    const path = previous?.dataset.path;
    this.root.replaceChildren(...elements);
    const next = this.root.querySelector('.diff-code');
    if (next && next.dataset.path === path) { next.scrollTop = scroll; next.scrollLeft = scrollLeft; }
  }

  diff(file) {
    const panel = element('section', 'file-diff');
    panel.append(element('h3', '', file.path));
    const code = element('pre', 'diff-code');
    code.tabIndex = 0;
    code.dataset.path = file.path;
    code.setAttribute('aria-label', `Changes in ${file.path}`);
    if (!file.diff) code.textContent = 'No text preview is available for this file.';
    else for (const line of file.diff.split('\n')) {
      const type = /^(---|\+\+\+|diff |index )/.test(line) ? 'meta' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : 'context';
      code.append(element('span', `diff-line ${type}`, line || ' '));
    }
    panel.append(code);
    if (file.truncated) panel.append(element('p', 'changes-notice', 'Preview truncated for this file.'));
    return panel;
  }
}
