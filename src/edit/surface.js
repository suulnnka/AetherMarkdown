// 编辑面（D34 行块模型）：MarkdownEditor 主类
//
// 每行一个块、扁平 DOM、无虚拟段机制：
//  - 空行是真实单元，光标可进入，输入直接同步
//  - 输入 → 同步源文本 → 重解析对齐 → 局部/全量渲染 → 光标还原
//  - IME 合成期零 DOM 操作；粘贴纯文本化；复制输出源文本
//  - 块级撤销栈；只读模式；主题切换（宿主元素 data-theme）

import { Document } from '../core/document.js';
import { UndoStack } from '../core/undo.js';
import { renderDoc, buildActiveElement } from '../render/dom.js';
import { BASE_CSS } from '../render/styles.js';
import { handleKeydown } from './keyboard.js';
import {
  extractText,
  charOffsetIn,
  setCollapsed,
  domToContentOff,
  contentToSrc,
} from './selection.js';

export class MarkdownEditor {
  constructor(opts = {}) {
    if (!opts || !(opts.target instanceof HTMLElement)) {
      throw new Error('AetherMarkdown: options.target (HTMLElement) 必填');
    }
    this._target = opts.target;
    this.readonly = !!opts.readonly;
    this._historyLimit = opts.historyLimit ?? 200;
    this._events = { change: [], focus: [], blur: [], imageClick: [] };
    this._destroyed = false;
    this._composing = false;
    this._activeId = null;
    this._selRaf = 0;

    // 编辑面直接挂在宿主元素下（light DOM）：Shadow DOM 内的 Selection/键盘
    // 事件在 WebKit 等引擎不可靠；样式隔离由 .aether-host 强作用域实现
    const host = document.createElement('div');
    host.className = 'aether-host';
    host.dataset.theme = opts.theme ?? 'light';
    this._target.replaceChildren(host);
    this._host = host;
    this._root = host;

    const style = document.createElement('style');
    style.textContent = BASE_CSS;
    this._host.append(style);

    this._surface = document.createElement('div');
    this._surface.className = 'md-surface';
    this._surface.setAttribute('role', 'textbox');
    this._surface.setAttribute('aria-multiline', 'true');
    this._surface.contentEditable = this.readonly ? 'false' : 'true';
    this._host.append(this._surface);

    this.doc = new Document(String(opts.value ?? ''));
    this._undo = new UndoStack(this._historyLimit);
    this._renderAll();
    this._undo.reset({ source: this.doc.source, caret: null, unitId: null, typing: false });

    this._bind();
  }

  // ---------- 公开 API ----------

  getValue() {
    return this.doc.source;
  }

  setValue(value, o = {}) {
    this._checkAlive();
    this.doc = new Document(String(value ?? ''));
    this._activeId = null;
    this._lastCaret = null;
    this._renderAll();
    if (o.resetHistory !== false) {
      this._undo.reset({ source: this.doc.source, caret: null, unitId: null, typing: false });
    }
    this._emit('change', this.doc.source);
  }

  focus(position) {
    this._checkAlive();
    this._surface.focus();
    const units = this.doc.units.filter((u) => u.editable);
    let target = null;
    if (position === 'end') target = units[units.length - 1];
    else if (position === 'start' || !this._lastCaret) target = units[0];
    else {
      this._restoreCaret(this._lastCaret);
      return;
    }
    if (!target) return;
    this._activate(target, position === 'end' ? target.range[1] - target.range[0] : 0);
  }

  blur() {
    this._surface.blur();
  }

  setReadonly(v) {
    this._checkAlive();
    this.readonly = !!v;
    this._surface.contentEditable = this.readonly ? 'false' : 'true';
    if (this.readonly) this._surface.setAttribute('aria-readonly', 'true');
    else this._surface.removeAttribute('aria-readonly');
    if (this.readonly) {
      this._activeId = null;
      this._renderAll();
    }
  }

  setTheme(t) {
    this._checkAlive();
    this._host.dataset.theme = t;
  }

  on(event, cb) {
    if (this._events[event]) this._events[event].push(cb);
    return this;
  }

  off(event, cb) {
    if (!this._events[event]) return this;
    if (cb == null) this._events[event].length = 0;
    else this._events[event] = this._events[event].filter((f) => f !== cb);
    return this;
  }

  destroy() {
    if (this._destroyed) return;
    this._unbind();
    this._target.replaceChildren();
    this._destroyed = true;
  }

  // ---------- 渲染与激活 ----------

  _renderAll() {
    this._rendering = true;
    try {
      renderDoc(this._surface, this.doc, this._activeId);
    } finally {
      this._rendering = false;
    }
    this._lastSig = this.doc.signature(this._activeId);
  }

  _findEl(id) {
    return this._surface.querySelector(`[data-id="${id}"]`);
  }

  _activate(unit, elOff) {
    this._activeId = unit.id;
    this._renderAll();
    const elu = this._findEl(unit.id);
    if (elu) setCollapsed(elu, elOff ?? 0);
  }

  // 局部重建活动单元元素（编辑态标记着色随内容变化）
  _refreshActiveEl(u, caretOff) {
    const old = this._findEl(u.id);
    if (!old) return;
    const neu = buildActiveElement(u, this.doc);
    old.replaceWith(neu);
    setCollapsed(neu, Math.max(0, caretOff - u.range[0]));
  }

  // ---------- 光标读取 ----------

  _readCaretPos() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    if (!this._surface.contains(r.startContainer)) return null;
    return { node: r.startContainer, offset: r.startOffset };
  }

  _unitElAt(node) {
    let n = node;
    while (n && n !== this._surface) {
      if (n.nodeType === Node.ELEMENT_NODE && n.dataset && n.dataset.id != null) {
        return { el: n, id: Number(n.dataset.id) };
      }
      n = n.parentNode;
    }
    return null;
  }

  _caretUnit() {
    const pos = this._readCaretPos();
    if (!pos) return null;
    const hit = this._unitElAt(pos.node);
    if (!hit) return null;
    const unit = this.doc.unitById(hit.id);
    if (!unit) return null;
    return { unit, el: hit.el, node: pos.node, nodeOff: pos.offset };
  }

  _pointSrcOff(node, offset) {
    if (node === this._surface) {
      return offset === 0 ? 0 : this.doc.source.length;
    }
    const hit = this._unitElAt(node);
    if (!hit) return null;
    const unit = this.doc.unitById(hit.id);
    if (!unit) return null;
    if (hit.el.classList.contains('md-active')) {
      return unit.range[0] + charOffsetIn(hit.el, node, offset);
    }
    const contentOff = domToContentOff(node, offset);
    if (contentOff == null) return unit.range[0];
    return contentToSrc(unit, contentOff);
  }

  // 渲染态光标位置 → 源偏移。
  // 行首/行尾吸附：可见内容的第一个/最后一个光标位对齐源码内容起点与行尾，
  // 否则行尾隐藏的行内语法（**、](url) 等）会把光标留在源码行中部
  _renderedSrcOff(c) {
    const u = c.unit;
    if (!u.lines) {
      const charOff = charOffsetIn(c.el, c.node, c.nodeOff);
      if (charOff >= extractText(c.el).length) return u.range[1];
      if (charOff <= 0) return u.textStart;
    }
    const contentOff = domToContentOff(c.node, c.nodeOff);
    return contentOff == null ? u.range[0] : contentToSrc(u, contentOff);
  }

  _caretSrcOff() {
    const pos = this._readCaretPos();
    if (!pos) return null;
    return this._pointSrcOff(pos.node, pos.offset);
  }

  _selectionSrcRange() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    if (!this._surface.contains(r.startContainer) || !this._surface.contains(r.endContainer)) return null;
    const a = this._pointSrcOff(r.startContainer, r.startOffset);
    const b = this._pointSrcOff(r.endContainer, r.endOffset);
    if (a == null || b == null) return null;
    return a <= b ? [a, b] : [b, a];
  }

  _ensureActiveCaret() {
    const c = this._caretUnit();
    if (!c) return null;
    if (c.el.classList.contains('md-active')) {
      return { unit: c.unit, srcOff: c.unit.range[0] + charOffsetIn(c.el, c.node, c.nodeOff) };
    }
    const srcOff = this._renderedSrcOff(c);
    this._activate(c.unit, srcOff - c.unit.range[0]);
    return { unit: c.unit, srcOff };
  }

  // ---------- 编辑后统一流程 ----------

  _applyStructural(caretOff, o = {}) {
    this.doc.rebuild();
    this._finishEdit(caretOff, { typing: o.typing ?? false });
  }

  _finishEdit(caretOff, { typing = false } = {}) {
    if (caretOff == null) caretOff = 0;
    // 光标落在不可编辑单元（hr）上——如整行输入成 ---：顺移到下一可编辑行行首；
    // 其后没有可编辑行（hr 为末行）则补一个空行承接光标
    if (!this.doc.editableAt(caretOff)) {
      const next = this.doc.units.find((u) => u.editable && u.range[0] >= caretOff);
      if (next) {
        caretOff = next.range[0];
      } else {
        this.doc.splice(this.doc.source.length, this.doc.source.length, '\n');
        this.doc.rebuild();
        caretOff = this.doc.source.length;
      }
    }
    this._lastCaret = caretOff;
    const containing = this.doc.editableAt(caretOff);
    const activeChanged = !containing || containing.id !== this._activeId;
    if (containing) this._activeId = containing.id;
    const sig = this.doc.signature(this._activeId);
    const mustRender = sig !== this._lastSig || activeChanged;
    if (mustRender) {
      this._renderAll();
      this._restoreCaret(caretOff);
    } else if (containing) {
      this._refreshActiveEl(containing, caretOff);
    }
    this._undo.push({ source: this.doc.source, caret: caretOff, unitId: this._activeId, typing });
    this._emit('change', this.doc.source);
  }

  _restoreCaret(srcOff) {
    if (srcOff == null) return;
    const u = this.doc.editableAt(srcOff);
    if (!u) return;
    this._activeId = u.id;
    this._renderAll();
    const elu = this._findEl(u.id);
    if (elu) setCollapsed(elu, srcOff - u.range[0]);
  }

  // ---------- 输入 / 粘贴 / 选区删除 ----------

  _onInput() {
    if (this._destroyed || this.readonly || this._composing) return;
    const u = this.doc.unitById(this._activeId);
    if (!u || !u.editable) return;
    const elu = this._findEl(u.id);
    if (!elu || !elu.classList.contains('md-active')) return;
    const text = extractText(elu);
    if (text === this.doc.source.slice(u.range[0], u.range[1])) return; // 幂等
    const c = this._caretUnit();
    const elOff = c && c.el === elu ? charOffsetIn(elu, c.node, c.nodeOff) : text.length;
    this.doc.splice(u.range[0], u.range[1], text);
    this._applyStructural(u.range[0] + elOff, { typing: true });
  }

  _onBeforeInput(e) {
    if (this._destroyed || this.readonly || this._composing) return;
    if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward') {
      const selRange = this._selectionSrcRange();
      if (selRange) {
        e.preventDefault();
        this._deleteSelection();
      }
      return;
    }
    if (e.inputType !== 'insertText' || !e.data) return;
    const c = this._caretUnit();
    if (!c || c.el.classList.contains('md-active')) return;
    e.preventDefault();
    const act = this._ensureActiveCaret();
    if (!act) return;
    this.doc.splice(act.srcOff, act.srcOff, e.data);
    this._applyStructural(act.srcOff + e.data.length, { typing: true });
  }

  _insertPlainText(text) {
    const act = this._ensureActiveCaret();
    if (!act) return;
    this.doc.splice(act.srcOff, act.srcOff, text);
    this._applyStructural(act.srcOff + text.length, { typing: false });
  }

  _onPaste(e) {
    if (this._destroyed || this.readonly) return;
    e.preventDefault();
    const text = ((e.clipboardData && e.clipboardData.getData('text/plain')) || '').replace(/\r/g, '');
    if (!text) return;
    const selRange = this._selectionSrcRange();
    if (selRange) {
      this.doc.deleteRange(selRange[0], selRange[1]);
      this.doc.rebuild();
      this._restoreCaret(selRange[0]);
    }
    this._insertPlainText(text);
  }

  _onCopy(e) {
    const r = this._selectionSrcRange();
    if (!r) return;
    e.clipboardData.setData('text/plain', this.doc.source.slice(r[0], r[1]));
    e.preventDefault();
  }

  _onCut(e) {
    if (this.readonly) return;
    const r = this._selectionSrcRange();
    if (!r) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', this.doc.source.slice(r[0], r[1]));
    this._deleteSelection();
  }

  _deleteSelection() {
    const r = this._selectionSrcRange();
    if (!r) return false;
    this._applyStructural(this.doc.deleteRange(r[0], r[1]));
    return true;
  }

  // ---------- 撤销 / 重做 ----------

  _snapshot() {
    return { source: this.doc.source, caret: this._caretSrcOff(), unitId: this._activeId, typing: false };
  }

  _doUndo() {
    if (!this._undo.canUndo()) return;
    this._applySnapshot(this._undo.undo(this._snapshot()));
  }

  _doRedo() {
    if (!this._undo.canRedo()) return;
    this._applySnapshot(this._undo.redo(this._snapshot()));
  }

  _applySnapshot(s) {
    this.doc = new Document(s.source);
    this._activeId = null;
    this._renderAll();
    this._restoreCaret(s.caret);
    this._lastCaret = s.caret;
    this._emit('change', this.doc.source);
  }

  // ---------- 事件绑定 ----------

  _bind() {
    this._handlers = [
      [this._surface, 'keydown', (e) => handleKeydown(this, e)],
      [this._surface, 'input', () => this._onInput()],
      [this._surface, 'beforeinput', (e) => this._onBeforeInput(e)],
      [this._surface, 'paste', (e) => this._onPaste(e)],
      [this._surface, 'copy', (e) => this._onCopy(e)],
      [this._surface, 'cut', (e) => this._onCut(e)],
      [this._surface, 'compositionstart', () => {
        this._composing = true;
        const c = this._caretUnit();
        if (c && !c.el.classList.contains('md-active')) this._ensureActiveCaret();
      }],
      [this._surface, 'compositionend', () => { this._composing = false; this._onInput(); }],
      [this._surface, 'focus', () => this._emit('focus')],
      [this._surface, 'blur', () => this._onSurfaceBlur()],
      [this._surface, 'focusout', () => this._onSurfaceBlur()],
      [this._surface, 'click', (e) => this._onClick(e)],
      [this._surface, 'drop', (e) => e.preventDefault()],
      [this._surface, 'dragover', (e) => e.preventDefault()],
      [document, 'selectionchange', () => this._onSelectionChange()],
    ];
    for (const [t, ev, fn] of this._handlers) t.addEventListener(ev, fn);

    this._mo = new MutationObserver(() => {
      if (this._destroyed || this._rendering || this._composing || this.readonly) return;
      queueMicrotask(() => this._onInput());
    });
    this._mo.observe(this._surface, { characterData: true, childList: true, subtree: true });
  }

  _unbind() {
    for (const [t, ev, fn] of this._handlers) t.removeEventListener(ev, fn);
    if (this._selRaf) clearTimeout(this._selRaf);
    if (this._mo) this._mo.disconnect();
  }

  _onSurfaceBlur() {
    this._activeId = null;
    this._renderAll();
    this._emit('blur');
  }

  _onSelectionChange() {
    if (this._destroyed || this._composing || this.readonly) return;
    if (this._selRaf) return;
    this._selRaf = setTimeout(() => {
      this._selRaf = 0;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const r = sel.getRangeAt(0);
      if (!this._surface.contains(r.startContainer)) return;
      if (!sel.isCollapsed) return;
      const c = this._caretUnit();
      if (!c || c.unit.id === this._activeId) return;
      let elOff = 0;
      if (c.el.classList.contains('md-active')) {
        elOff = charOffsetIn(c.el, c.node, c.nodeOff);
      } else {
        elOff = Math.max(0, this._renderedSrcOff(c) - c.unit.range[0]);
      }
      this._activate(c.unit, elOff);
    });
  }

  _onClick(e) {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const a = t.closest('a');
    if (a) {
      e.preventDefault();
      window.open(a.href, '_blank', 'noopener');
      return;
    }
    // 图片点击：放大展示由宿主处理（imageClick 事件，D12 修订）。
    // 无监听时回落为激活该块（图片是原子元素，浏览器点击不落文本光标，需显式激活）
    const img = t.closest('img.md-img');
    if (img) {
      if (this._events.imageClick.length) {
        e.preventDefault();
        this._emit('imageClick', img.src);
      } else if (!this.readonly) {
        const hit = this._unitElAt(img);
        const unit = hit && this.doc.unitById(hit.id);
        if (unit) {
          const srcOff = img.__src ? contentToSrc(unit, img.__src[0]) : unit.range[0];
          this._activate(unit, srcOff - unit.range[0]);
        }
      }
      return;
    }

    // 分隔符不可编辑（无文本可落光标）：点击 = 光标到下一行行首（行首退格即删该行）
    if (!this.readonly) {
      const hr = t.closest('hr.md-hr');
      if (hr) {
        e.preventDefault();
        const sib = hr.nextElementSibling;
        const id = sib && sib.dataset ? Number(sib.dataset.id) : NaN;
        const unit = !Number.isNaN(id) && this.doc.unitById(id);
        if (unit && unit.editable) this._activate(unit, 0);
      }
    }
  }

  _emit(event, payload) {
    for (const cb of [...(this._events[event] || [])]) cb(payload);
  }

  _checkAlive() {
    if (this._destroyed) throw new Error('AetherMarkdown: editor destroyed');
  }
}
