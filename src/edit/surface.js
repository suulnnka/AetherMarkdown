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
import { sanitizeUrl } from '../parse/entities.js';
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
    this._compSettling = false; // WebKit 合成收尾期（compositionend 后一个宏任务内）
    this._compTimer = 0;
    this._activeId = null;
    this._selRaf = 0;
    this._hadFocus = false;

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
    const units = this.doc.units;
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

  /** 聚焦并进入末尾空行:传 clientY 时按点击位置进入下方第 N 行空位
   *  (不足则补足),否则进入(必要时新建)紧邻末条的空行 */
  focusEndBlank(clientY) {
    this._checkAlive();
    this._surface.focus();
    if (typeof clientY === 'number') this._enterEndBlankAt(clientY);
    else this._enterEndBlank();
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
    // renderDoc 赋予的排版类要带过来:局部重建不经过 renderDoc,丢了
    // md-gap-short 会让硬换行续行的间距在编辑态/渲染态之间来回跳(6px)
    if (old.classList.contains('md-gap-short')) neu.classList.add('md-gap-short');
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

  // ---------- 空白区点击(几何接管)----------
  // 点击落在行块之间的间隙、各行文本右侧/下方等空白处时,浏览器只能给出
  // surface 层级的元素选区(子元素序号),与点击位置常对不上 —— 后续按序号
  // 救援会把光标/滚动拽到别的行。这里在 pointerdown 阶段先做命中测试:
  // 命中测试给出具体文本位(非 surface 容器)→ 交原生(精确列位/拖选/双击
  // 选词都依赖原生);否则自接管,按几何落点就最近行,末行之下 = Notion 式
  // 进入(必要时新建)末尾空行。
  _probeCaretRange(x, y) {
    if (typeof document.caretRangeFromPoint !== 'function') return null;
    try { return document.caretRangeFromPoint(x, y); } catch { return null; }
  }

  _enterEndBlank() {
    const units = this.doc.units;
    const last = units[units.length - 1];
    if (last && last.kind === 'blank') { this._activate(last, 0); return; }
    const end = this.doc.source.length;
    this.doc.splice(end, end, '\n');
    this._applyStructural(end + 1, { typing: false });
  }

  /** 键盘 ↓ 在文末:向下再进入一行空行(已有尾空行也再补一条,连续 ↓ 连续下行) */
  _stepEndBlank() {
    const end = this.doc.source.length;
    this.doc.splice(end, end, '\n');
    this._applyStructural(end + 1, { typing: false });
  }

  /** 点击正文下方第 N 行空位:按几何行距算出 N,补足空行并把光标放进第 N 行
   *  (Notion 式:点哪儿光标就在哪一行,而不是全挤到末尾一条空行里) */
  _enterEndBlankAt(clientY) {
    const kids = [...this._surface.children];
    const units = this.doc.units;
    if (!kids.length) { this._enterEndBlank(); return; }
    /* N 必须从「最后一条内容行」数起(跳过尾随空行):锚到最后元素时,
     * 已有尾空行会把 N 压小,后续点击全部偏移、光标总跳回紧贴内容的第一
     * 条空行;已有尾空行按 N 复用,不足才补 */
    let have = 0;
    let li = kids.length - 1;
    while (li >= 0 && units[li] && units[li].kind === 'blank') { li--; have++; }
    const anchorEl = li >= 0 ? kids[li] : kids[0];
    const anchorBottom = anchorEl.getBoundingClientRect().bottom;
    /* 行距:有尾空行就实测(高度+margin,空行之间均匀);没有则按
     * line-height(≈1.4em)+ 行间距(0.4em)≈ 1.8em 估 */
    let pitch;
    if (have > 0) {
      const lastB = kids[kids.length - 1];
      const cs = getComputedStyle(lastB);
      pitch = Math.round(lastB.getBoundingClientRect().height + (parseFloat(cs.marginTop) || 0));
    } else {
      const fs = parseFloat(getComputedStyle(this._surface).fontSize) || 15;
      pitch = Math.max(12, Math.round(fs * 1.8));
    }
    if (!pitch || pitch < 8) pitch = 24;
    const n = Math.min(60, Math.max(1, Math.round((clientY - anchorBottom) / pitch + 0.5)));
    if (n <= have) {
      this._activate(units[units.length - have + (n - 1)], 0);
      return;
    }
    const end = this.doc.source.length;
    this.doc.splice(end, end, '\n'.repeat(n - have));
    this._applyStructural(end + (n - have), { typing: false });   // 光标到末尾 = 第 N 行
  }

  _onSurfacePointerDown(e) {
    if (this.readonly || this._destroyed || e.button !== 0 || e.shiftKey) return;
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('a, img, hr.md-hr')) return;   // 链接/图片/分隔符:走 _onMouseDown/_onClick
    /* 几何优先判定:末行之下 = 进入(必要时新建)末尾空行;首行之上 = 首行行首。
     * 不能先做命中测试 —— caretRangeFromPoint 会把正文下方的落点就近映射进
     * 末行文本,Notion 分支就永远走不到了。 */
    const kids = [...this._surface.children];
    if (!kids.length) { e.preventDefault(); this._surface.focus(); this._enterEndBlank(); return; }
    const rects = kids.map((k) => k.getBoundingClientRect());
    if (e.clientY > rects[rects.length - 1].bottom + 2) {
      e.preventDefault();
      this._surface.focus();
      this._enterEndBlankAt(e.clientY);   // 按点击位置进入下方第 N 行空位
      return;
    }
    if (e.clientY < rects[0].top - 2) {
      e.preventDefault();
      this._surface.focus();
      const first = this.doc.units[0];
      this._activate(first, (first.textStart ?? first.range[0]) - first.range[0]);
      return;
    }
    /* 行块之间/文本右侧等空白:命中测试能给出具体文本位(非 surface 容器)
     * → 交原生(精确列位/拖选/双击选词都依赖原生);退化才自接管按几何就近 */
    const probe = this._probeCaretRange(e.clientX, e.clientY);
    if (probe && probe.startContainer !== this._surface) return;
    e.preventDefault();
    this._surface.focus();
    this._placeGeom(e.clientX, e.clientY, probe, kids, rects);
  }

  _placeGeom(x, y, probe, kids, rects) {
    // 命中测试给出的具体文本位(可能是间隙点击映射到的邻行文本)直接采用
    if (probe && probe.startContainer !== this._surface) {
      const sel = window.getSelection();
      if (sel) {
        const r = probe.cloneRange();
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      }
      return;
    }
    let idx = rects.findIndex((r) => y >= r.top && y <= r.bottom);
    if (idx < 0) {   // 行间隙:取中线判定归属
      for (let i = 0; i < rects.length - 1; i++) {
        if (y > rects[i].bottom && y < rects[i + 1].top) {
          idx = y < (rects[i].bottom + rects[i + 1].top) / 2 ? i : i + 1;
          break;
        }
      }
      if (idx < 0) { this._enterEndBlank(); return; }
    }
    // 行内落位拿不到列位:按文本中点分行首/行尾
    const u = this.doc.units[idx];
    const tr = document.createRange();
    tr.selectNodeContents(kids[idx]);
    const trect = tr.getBoundingClientRect();
    const srcOff = x < (trect.left + trect.right) / 2 ? (u.textStart ?? u.range[0]) : u.range[1];
    this._activate(u, srcOff - u.range[0]);
  }

  // 可操作光标：_caretUnit 之上兜底 surface 层级选区——WebKit 点击行首/行尾
  // 边缘常给出 (surface, offset) 元素偏移而非文本节点，若无兜底，激活与
  // 输入拦截都会跳过，字符插到无单元管辖的区域，随后的重渲染会将其清除。
  // 折算规则：offset 0 → 首个可编辑单元行首（吸附到内容起点）；其余 → 末个可编辑单元行尾
  _actionableCaret() {
    const c = this._caretUnit();
    if (c) return c;
    const pos = this._readCaretPos();
    if (!pos || pos.node !== this._surface) return null;
    // (surface, k) 的 k 即子元素序号。边界紧邻分隔符时落到分隔符行
    // （srcOff 行尾）：键盘上下穿越进入 --- 编辑态，而非停在元素边界的虚空行；
    // 其余：0 → 首行行首；k ≥ 子数 → 末行行尾；否则第 k 行行首（点行间空隙落紧邻行）
    const kids = this._surface.children;
    if (!kids.length) return null;
    const k = Math.max(0, Math.min(pos.offset, kids.length));
    const last = k === kids.length;
    let elu;
    if (!last && kids[k].classList.contains('md-hr')) {
      elu = kids[k];
    } else if (!last && k > 0 && kids[k - 1].classList.contains('md-hr')) {
      elu = kids[k - 1];
    } else {
      elu = last ? kids[kids.length - 1] : kids[k];
    }
    const id = elu && elu.dataset ? Number(elu.dataset.id) : NaN;
    const u = !Number.isNaN(id) && this.doc.unitById(id);
    if (!u) return null;
    const isHr = elu.classList.contains('md-hr') && !elu.classList.contains('md-active');
    const nodeOff = isHr ? 0 : last ? elu.childNodes.length : 0;
    // srcOff：分隔符行显式取行尾（其渲染元素无子节点，常规映射只能得到行首）
    const res = { unit: u, el: elu, node: elu, nodeOff, rescued: true };
    if (isHr) res.srcOff = u.range[1];
    return res;
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
    const c = this._actionableCaret();
    if (!c) return null;
    if (c.el.classList.contains('md-active')) {
      return { unit: c.unit, srcOff: c.unit.range[0] + charOffsetIn(c.el, c.node, c.nodeOff) };
    }
    const srcOff = c.srcOff ?? this._renderedSrcOff(c);
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

  // WebKit 与 Chrome 的合成收尾顺序不同：Chrome 先把最终文本写进 DOM 再发
  // compositionend；WebKit 在 compositionend 之后引擎侧还会做最后一次提交/清理。
  // 若在 compositionend 里同步读 DOM 并重渲染（renderDoc 会 replaceChildren 整个
  // surface），引擎仍持有的文本节点被换掉，合成文本随后被引擎回退清空，
  // MutationObserver 再把"丢失"同步回 source——表现为输入的文字过一会消失。
  // 因此合成结束后延迟一个宏任务，等引擎彻底收尾再统一读取 DOM 终态。
  _deferCompositionSync() {
    this._compSettling = true;
    if (this._compTimer) return;
    this._compTimer = setTimeout(() => {
      this._compTimer = 0;
      this._compSettling = false;
      if (!this._destroyed && !this._composing) this._onInput();
    }, 0);
  }

  // 用户主动操作（按键/粘贴）到来时立即结算挂起的合成同步：
  // 此时引擎必然已收尾，先读终态再执行该操作，避免旧 source 把合成文本冲掉
  _flushCompositionSync() {
    if (!this._compSettling) return;
    if (this._compTimer) {
      clearTimeout(this._compTimer);
      this._compTimer = 0;
    }
    this._compSettling = false;
    if (!this._destroyed && !this._composing) this._onInput();
  }

  _onInput() {
    if (this._destroyed || this.readonly || this._composing || this._compSettling) return;
    const u = this.doc.unitById(this._activeId);
    if (!u) return;
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
    // 跨块选区上输入:浏览器默认编辑会把行块子树整个替换成文本节点,
    // data-id 丢失后 _onInput 同步短路、DOM 与源码分叉——必须拦下走源文本变换
    const selRange = this._selectionSrcRange();
    if (selRange) {
      e.preventDefault();
      this.doc.splice(selRange[0], selRange[1], e.data);
      this._applyStructural(selRange[0] + e.data.length, { typing: true });
      return;
    }
    const c = this._actionableCaret();
    if (!c || c.el.classList.contains('md-active')) return;
    // 光标在渲染态行上:先激活该行、落好光标,再放行默认插入 —— 不
    // preventDefault,让字符走原生管线插入到刚激活元素的光标处。
    // 拦截+手动插入会把长按连发/输入法等系统输入特性挡在门外。
    const act = this._ensureActiveCaret();
    if (!act) e.preventDefault();
  }

  _insertPlainText(text) {
    const act = this._ensureActiveCaret();
    if (!act) return;
    this.doc.splice(act.srcOff, act.srcOff, text);
    this._applyStructural(act.srcOff + text.length, { typing: false });
  }

  _onPaste(e) {
    if (this._destroyed || this.readonly) return;
    this._flushCompositionSync();
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
      [this._surface, 'keydown', (e) => { this._flushCompositionSync(); handleKeydown(this, e); }],
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
      [this._surface, 'compositionend', () => { this._composing = false; this._deferCompositionSync(); }],
      [this._surface, 'focus', () => {
        this._hadFocus = true;
        this._emit('focus');
      }],
      [this._surface, 'blur', () => this._onSurfaceBlur()],
      [this._surface, 'focusout', () => this._onSurfaceBlur()],
      // 空白区点击几何接管(须先于 mousedown:preventDefault 才能拦下原生落光标)
      [this._surface, 'pointerdown', (e) => this._onSurfacePointerDown(e)],
      // 链接/图片上按下不落光标：否则 selectionchange 会先把行切成编辑态、
      // DOM 被替换，随后的 click 落点失效（链接就打不开了）
      [this._surface, 'mousedown', (e) => this._onMouseDown(e)],
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
    if (this._compTimer) clearTimeout(this._compTimer);
    if (this._mo) this._mo.disconnect();
  }

  // blur 与 focusout 在失焦时都会触发；_hadFocus 保证 blur 事件只发一次
  _onSurfaceBlur() {
    if (!this._hadFocus) return;
    this._hadFocus = false;
    this._activeId = null;
    this._renderAll();
    this._emit('blur');
  }

  _onSelectionChange() {
    if (this._destroyed || this._composing || this.readonly) return;
    if (this._selRaf) return;
    this._selRaf = setTimeout(() => {
      this._selRaf = 0;
      if (this._compSettling) return; // 合成收尾期不重渲染（会读到未同步的旧 source）
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const r = sel.getRangeAt(0);
      if (!this._surface.contains(r.startContainer)) return;
      if (!sel.isCollapsed) return;
      const c = this._actionableCaret();
      if (!c) return;
      if (c.unit.id === this._activeId) {
        // 仅 surface 层级兜底光标（rescued）需要拉回单元内——停在虚空位置时
        // 后续输入会落到单元外；真实单元内光标（_caretUnit 命中）绝不能重设，
        // 否则行内方向键移动会被拽回（多节点行如 # 前缀标题首当其冲）。
        // nodeOff 是元素子节点序号，需经 charOffsetIn 换算为字符偏移
        if (c.rescued && c.el.classList.contains('md-active')) {
          setCollapsed(c.el, charOffsetIn(c.el, c.el, c.nodeOff));
        }
        return;
      }
      let elOff = 0;
      if (c.srcOff != null) {
        elOff = c.srcOff - c.unit.range[0];
      } else if (c.el.classList.contains('md-active')) {
        elOff = charOffsetIn(c.el, c.node, c.nodeOff);
      } else {
        elOff = Math.max(0, this._renderedSrcOff(c) - c.unit.range[0]);
      }
      this._activate(c.unit, elOff);
    });
  }

  _onMouseDown(e) {
    if (this.readonly) return; // 只读态保留原生文本选择
    const t = e.target;
    // 链接/图片/分隔符上按下不落光标：否则 selectionchange 先激活/抢占，
    // DOM 被替换后 click 落点失效（链接打不开、分隔符点不中）
    if (t instanceof Element && (t.closest('a') || t.closest('img.md-img') || t.closest('hr.md-hr'))) e.preventDefault();
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

    // 编辑态链接（span，携带 dataset.href）：点击 URL 尾部（弱化标记）或
    // Cmd/Ctrl+点击任意部分 → 打开；点击链接文本本身仍是落光标编辑
    const le = t.closest('.md-link-edit');
    if (le && le.dataset.href && (t.closest('.md-marker') || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const href = sanitizeUrl(le.dataset.href);
      if (href) window.open(href, '_blank', 'noopener');
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

    // 分隔符可编辑（D38）但渲染态是 <hr> 无文本可落光标：
    // 点击 = 激活该行（编辑态显示 --- 源码，光标行尾）
    if (!this.readonly) {
      const hr = t.closest('hr.md-hr');
      if (hr) {
        e.preventDefault();
        const hit = this._unitElAt(hr);
        const unit = hit && this.doc.unitById(hit.id);
        if (unit) this._activate(unit, unit.range[1] - unit.range[0]);
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
