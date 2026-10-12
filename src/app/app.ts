import { CommonModule } from '@angular/common';
import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  BlobReader,
  BlobWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter
} from '@zip.js/zip.js';

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  file?: File;
  size: number;
  children: TreeNode[];
  expanded: boolean;
  checked: boolean;
  indeterminate: boolean;
}

interface FlatNode {
  node: TreeNode;
  depth: number;
}

const SKIP_NODE_MODULES = new Set(['node_modules', '.git', '.svn', 'bower_components']);
const SKIP_PYTHON_ENVS = new Set([
  'venv', '.venv', 'env', '__pycache__', '.env',
  'site-packages', '.tox', '.pytest_cache', '.mypy_cache'
]);

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected readonly title = signal('Hasher');
  protected readonly theme = signal<'light' | 'dark'>(this.getSavedTheme());
  protected readonly createPassword = signal('');
  protected readonly encodedText = signal('');
  protected readonly decodePassword = signal('');
  protected readonly incomingText = signal('');
  protected readonly status = signal('Pick files or a folder to start.');
  protected readonly error = signal('');
  protected readonly isWorking = signal(false);
  protected readonly isLoading = signal(false);
  protected readonly loadingMsg = signal('');
  protected readonly skipNodeModules = signal(true);
  protected readonly skipPythonEnv = signal(true);
  /** Actual zip byte count – set after createEncryptedText() runs */
  protected readonly zipSizeBytes = signal(0);

  // Raw file store – preserved across skip-setting changes
  private allRawFiles: File[] = [];

  // Mutable tree; treeVersion signals Angular to re-evaluate computed()
  protected tree: TreeNode[] = [];
  protected readonly treeVersion = signal(0);

  protected readonly flatTree = computed((): FlatNode[] => {
    void this.treeVersion();
    return this.flattenTree(this.tree, 0);
  });

  protected readonly selectedFiles = computed(() => {
    void this.treeVersion();
    return this.collectCheckedFiles(this.tree);
  });

  protected readonly totalBytes = computed(() =>
    this.selectedFiles().reduce((s, f) => s + f.size, 0)
  );

  /** Base64-encoded text length (characters ≈ bytes for ASCII) */
  protected readonly encodedTextSize = computed(() => this.encodedText().length);

  protected readonly compressionRatio = computed(() => {
    const orig = this.totalBytes();
    const txt = this.encodedTextSize();
    if (orig === 0 || txt === 0) return null;
    return Math.round((1 - txt / orig) * 100);
  });

  protected toggleTheme(): void {
    const nextTheme = this.theme() === 'light' ? 'dark' : 'light';
    localStorage.setItem('hasher-theme', nextTheme);
    this.theme.set(nextTheme);
  }

  private getSavedTheme(): 'light' | 'dark' {
    return localStorage.getItem('hasher-theme') === 'dark' ? 'dark' : 'light';
  }

  // ── File picking ──────────────────────────────────────────────────────────

  protected async onFilesPicked(event: Event): Promise<void> {
    this.error.set('');
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;

    // Snapshot file list and clear the input immediately so the user can
    // pick more files while we're processing this batch.
    const incoming = Array.from(input.files);
    input.value = '';

    this.isLoading.set(true);
    this.loadingMsg.set(`Reading ${incoming.length} file(s)…`);

    // Yield one frame so the spinner can render before heavy sync work starts.
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    const existingPaths = new Set(this.allRawFiles.map(f => this.getRelativePath(f)));
    for (const file of incoming) {
      const p = this.getRelativePath(file);
      if (!existingPaths.has(p)) {
        this.allRawFiles.push(file);
        existingPaths.add(p);
      }
    }

    await this.rebuildTreeAsync(true);
    this.status.set(`${this.selectedFiles().length} file(s) ready.`);
    this.isLoading.set(false);
    this.loadingMsg.set('');
  }

  protected onSkipChange(): void {
    if (this.allRawFiles.length === 0) return;
    this.isLoading.set(true);
    this.loadingMsg.set('Applying filter…');
    // setTimeout so the loading state renders before sync rebuild
    setTimeout(async () => {
      await this.rebuildTreeAsync(true);
      this.status.set(`Filter applied. ${this.selectedFiles().length} file(s) ready.`);
      this.isLoading.set(false);
      this.loadingMsg.set('');
    }, 0);
  }

  // ── Tree construction ─────────────────────────────────────────────────────

  /**
   * Builds the tree in 500-file chunks, yielding the main thread between
   * each chunk so the loading spinner stays visible for large folders.
   */
  private async rebuildTreeAsync(preserveState = false): Promise<void> {
    const skipNM = this.skipNodeModules();
    const skipPy = this.skipPythonEnv();
    const CHUNK = 500;

    const uncheckedPaths = new Set<string>();
    if (preserveState) this.collectUncheckedPaths(this.tree, uncheckedPaths);

    this.tree = [];
    const files = this.allRawFiles;

    for (let i = 0; i < files.length; i += CHUNK) {
      const end = Math.min(i + CHUNK, files.length);
      this.loadingMsg.set(`Building tree… ${end} / ${files.length}`);

      for (let j = i; j < end; j++) {
        const file = files[j];
        const rel = this.getRelativePath(file);
        const parts = rel.split('/').filter(p => p.length > 0);
        if (parts.length === 0) continue;
        if (this.shouldSkip(parts, skipNM, skipPy)) continue;
        this.insertFile(this.tree, parts, 0, file);
      }

      // Yield between chunks so Angular can update the DOM (shows progress)
      if (end < files.length) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    }

    this.sortTree(this.tree);

    if (preserveState && uncheckedPaths.size > 0) {
      this.applyUncheckedPaths(this.tree, uncheckedPaths);
    }

    this.updateParentStates(this.tree);
    this.treeVersion.update(v => v + 1);
  }

  private shouldSkip(parts: string[], skipNM: boolean, skipPy: boolean): boolean {
    // Only check directory segments (all but the last part which is the filename)
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (skipNM && SKIP_NODE_MODULES.has(seg)) return true;
      if (skipPy && SKIP_PYTHON_ENVS.has(seg)) return true;
    }
    return false;
  }

  private insertFile(nodes: TreeNode[], parts: string[], depth: number, file: File): void {
    const name = parts[depth];
    const isLast = depth === parts.length - 1;

    if (isLast) {
      if (!nodes.some(n => n.name === name && !n.isDir)) {
        nodes.push({
          name,
          path: parts.slice(0, depth + 1).join('/'),
          isDir: false,
          file,
          size: file.size,
          children: [],
          expanded: false,
          checked: true,
          indeterminate: false
        });
      }
    } else {
      let dir = nodes.find(n => n.name === name && n.isDir);
      if (!dir) {
        dir = {
          name,
          path: parts.slice(0, depth + 1).join('/'),
          isDir: true,
          size: 0,
          children: [],
          expanded: depth < 2,
          checked: true,
          indeterminate: false
        };
        nodes.push(dir);
      }
      this.insertFile(dir.children, parts, depth + 1, file);
    }
  }

  private sortTree(nodes: TreeNode[]): void {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.isDir && n.children.length > 0) this.sortTree(n.children);
    }
  }

  private updateParentStates(nodes: TreeNode[]): void {
    for (const n of nodes) {
      if (n.isDir && n.children.length > 0) {
        this.updateParentStates(n.children);
        const allOn = n.children.every(c => c.checked && !c.indeterminate);
        const allOff = n.children.every(c => !c.checked && !c.indeterminate);
        n.checked = allOn;
        n.indeterminate = !allOn && !allOff;
      }
    }
  }

  private collectUncheckedPaths(nodes: TreeNode[], result: Set<string>): void {
    for (const n of nodes) {
      if (!n.isDir && !n.checked) result.add(n.path);
      if (n.isDir) this.collectUncheckedPaths(n.children, result);
    }
  }

  private applyUncheckedPaths(nodes: TreeNode[], unchecked: Set<string>): void {
    for (const n of nodes) {
      if (!n.isDir && unchecked.has(n.path)) n.checked = false;
      if (n.isDir) this.applyUncheckedPaths(n.children, unchecked);
    }
  }

  private flattenTree(nodes: TreeNode[], depth: number): FlatNode[] {
    const result: FlatNode[] = [];
    for (const node of nodes) {
      result.push({ node, depth });
      if (node.isDir && node.expanded) {
        result.push(...this.flattenTree(node.children, depth + 1));
      }
    }
    return result;
  }

  private collectCheckedFiles(nodes: TreeNode[]): Array<{ path: string; file: File; size: number }> {
    const result: Array<{ path: string; file: File; size: number }> = [];
    for (const n of nodes) {
      if (!n.isDir && n.checked && n.file) {
        result.push({ path: n.path, file: n.file, size: n.size });
      } else if (n.isDir) {
        result.push(...this.collectCheckedFiles(n.children));
      }
    }
    return result;
  }

  // ── Tree interaction ──────────────────────────────────────────────────────

  protected toggleNode(node: TreeNode): void {
    // Indeterminate → click means "check all"; otherwise toggle
    const newChecked = node.indeterminate ? true : !node.checked;
    this.setCheckedRecursive(node, newChecked);
    this.updateParentStates(this.tree);
    this.treeVersion.update(v => v + 1);
  }

  protected toggleExpand(node: TreeNode, event: Event): void {
    event.stopPropagation();
    node.expanded = !node.expanded;
    this.treeVersion.update(v => v + 1);
  }

  protected selectAll(): void {
    for (const n of this.tree) this.setCheckedRecursive(n, true);
    this.treeVersion.update(v => v + 1);
  }

  protected selectNone(): void {
    for (const n of this.tree) this.setCheckedRecursive(n, false);
    this.treeVersion.update(v => v + 1);
  }

  protected clearAll(): void {
    this.allRawFiles = [];
    this.tree = [];
    this.encodedText.set('');
    this.zipSizeBytes.set(0);
    this.error.set('');
    this.status.set('Selection cleared.');
    this.treeVersion.update(v => v + 1);
  }

  protected countFiles(node: TreeNode): string {
    const total = this.countLeaves(node);
    const checked = this.countCheckedLeaves(node);
    return `${checked}/${total}`;
  }

  private countLeaves(n: TreeNode): number {
    if (!n.isDir) return 1;
    return n.children.reduce((s, c) => s + this.countLeaves(c), 0);
  }

  private countCheckedLeaves(n: TreeNode): number {
    if (!n.isDir) return n.checked ? 1 : 0;
    return n.children.reduce((s, c) => s + this.countCheckedLeaves(c), 0);
  }

  private setCheckedRecursive(node: TreeNode, checked: boolean): void {
    node.checked = checked;
    node.indeterminate = false;
    for (const child of node.children) this.setCheckedRecursive(child, checked);
  }

  // ── Encrypt ───────────────────────────────────────────────────────────────

  protected async createEncryptedText(): Promise<void> {
    if (this.isWorking()) return;
    this.error.set('');

    if (!this.selectedFiles().length) {
      this.error.set('Select at least one file first.');
      return;
    }
    if (!this.createPassword()) {
      this.error.set('Enter a password to encrypt your zip.');
      return;
    }

    this.isWorking.set(true);
    this.status.set('Compressing & encrypting…');

    try {
      const zipWriter = new ZipWriter(new BlobWriter('application/zip'), {
        password: this.createPassword(),
        encryptionStrength: 3
      });

      for (const sel of this.selectedFiles()) {
        await zipWriter.add(sel.path, new BlobReader(sel.file), {
          lastModDate: new Date(sel.file.lastModified),
          level: 9          // maximum DEFLATE compression before AES encryption
        });
      }

      const zipBlob = await zipWriter.close();
      const zipBytes = new Uint8Array(await zipBlob.arrayBuffer());
      this.zipSizeBytes.set(zipBytes.length);

      // ── Additional compression pass using native browser API ──────────────
      // A second deflate pass over the zip container helps when files compress
      // poorly individually but the zip header/table structures are repetitive.
      // We keep the result only when it's actually smaller.
      this.status.set('Optimising for text transfer…');
      const finalBytes = await this.maybeRecompress(zipBytes);

      this.encodedText.set(this.bytesToBase64(finalBytes));
      this.status.set('Encrypted text created. Copy it and share.');
    } catch (err) {
      this.error.set(this.toErrorMessage(err));
      this.status.set('Encryption failed.');
    } finally {
      this.isWorking.set(false);
    }
  }

  protected copyText(): void {
    if (!this.encodedText()) { this.error.set('No encoded text yet.'); return; }
    navigator.clipboard.writeText(this.encodedText())
      .then(() => { this.error.set(''); this.status.set('Copied to clipboard.'); })
      .catch(() => { this.error.set('Clipboard permission denied. Copy manually.'); });
  }

  // ── Decrypt ───────────────────────────────────────────────────────────────

  protected async recoverZipFromText(): Promise<void> {
    if (this.isWorking()) return;
    this.error.set('');

    if (!this.incomingText().trim()) { this.error.set('Paste encoded text first.'); return; }
    if (!this.decodePassword()) { this.error.set('Enter the decryption password.'); return; }

    this.isWorking.set(true);
    this.status.set('Validating text and password…');

    try {
      const rawBytes = this.base64ToBytes(this.incomingText());
      // Handle optional second compression pass made during encoding
      const bytes = await this.maybeDecompress(rawBytes);
      const reader = new ZipReader(new Uint8ArrayReader(bytes));
      const entries = await reader.getEntries();
      const firstFile = entries.find(e => !e.directory);
      if (!firstFile) throw new Error('No file entries found in decoded zip data.');

      await firstFile.getData(new Uint8ArrayWriter(), { password: this.decodePassword() });
      await reader.close();

      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      this.downloadBlob(new Blob([ab], { type: 'application/zip' }), 'recovered.zip');
      this.status.set('Zip downloaded. Open it with the same password.');
    } catch (err) {
      this.error.set(this.toErrorMessage(err));
      this.status.set('Recovery failed.');
    } finally {
      this.isWorking.set(false);
    }
  }

  // ── Compression helpers ──────────────────────────────────────────────────

  /**
   * Attempts a second deflate-raw pass over already-zipped bytes using the
   * browser's native CompressionStream. Returns the original bytes if
   * the second pass doesn't produce a smaller result.
   *
   * Why this exists: base64 adds a mandatory ~33 % overhead on top of binary
   * data. Maximising compression in the zip (level 9) reduces the binary size
   * as much as possible; this second pass occasionally squeezes a few more %
   * from repetitive zip headers and padding when file content was already
   * compressible. For truly incompressible data (images, videos) neither pass
   * helps with the 33 % base64 overhead — that is unavoidable when representing
   * binary as plain text.
   */
  private async maybeRecompress(bytes: Uint8Array): Promise<Uint8Array> {
    if (typeof CompressionStream === 'undefined') return bytes;
    try {
      const cs = new CompressionStream('deflate-raw');
      const csWriter = cs.writable.getWriter();
      csWriter.write(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      csWriter.close();

      const chunks: Uint8Array[] = [];
      const reader = cs.readable.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const totalLen = chunks.reduce((s, c) => s + c.length, 0);
      if (totalLen >= bytes.length) return bytes;   // no improvement — skip

      const out = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of chunks) { out.set(c, offset); offset += c.length; }
      return out;
    } catch {
      return bytes;   // CompressionStream failed — fall back to plain zip bytes
    }
  }

  /**
   * Reverses maybeRecompress: if the header bytes indicate deflate-raw
   * wrapping (NOT a zip PK header) decompress first, then hand off the zip.
   */
  private async maybeDecompress(bytes: Uint8Array): Promise<Uint8Array> {
    // PK zip magic: 0x50 0x4B
    if (bytes[0] === 0x50 && bytes[1] === 0x4B) return bytes;
    if (typeof DecompressionStream === 'undefined') return bytes;
    try {
      const ds = new DecompressionStream('deflate-raw');
      const dsWriter = ds.writable.getWriter();
      dsWriter.write(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      dsWriter.close();

      const chunks: Uint8Array[] = [];
      const reader = ds.readable.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const totalLen = chunks.reduce((s, c) => s + c.length, 0);
      const out = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of chunks) { out.set(c, offset); offset += c.length; }
      return out;
    } catch {
      return bytes;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  protected formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1_048_576).toFixed(2)} MB`;
  }

  private getRelativePath(file: File): string {
    const f = file as File & { webkitRelativePath?: string };
    return (f.webkitRelativePath || file.name).replace(/\\/g, '/');
  }

  private bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  private base64ToBytes(raw: string): Uint8Array {
    const binary = atob(raw.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  private downloadBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName; a.click();
    URL.revokeObjectURL(url);
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Unexpected error.';
  }
}
