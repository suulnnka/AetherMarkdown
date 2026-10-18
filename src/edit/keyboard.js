// 键盘行为（D34 行块模型）
//
//  - Enter = 分行：插入换行符，光标到新行行首（新行是真实的空行块）
//  - Shift+Enter = 短间距行：插入"两空格+换行"（下一行渲染为短间距）
//  - 行首 Backspace = 剥一层语法（标题→文字行、列表行降级/转文字行、引用降层），
//    已是最简形态则与上一行合并（行直接拼接）
//  - 行尾 Delete = 与下一行合并
//  - Tab：列表行整体缩进 ±2 空格；代码块内插入两空格；其余无操作

// 光标是否在单元的首/末视觉行（折行单元的中间行不触发跨界拦截；
// 取不到光标矩形时按边界处理，保证空块也能进入）
function onEdgeVisualLine(c, down) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return true;
  const cr = sel.getRangeAt(0).getBoundingClientRect();
  const er = c.el.getBoundingClientRect();
  if (!cr.height) return true;
  return down ? cr.bottom >= er.bottom - cr.height * 1.25 : cr.top <= er.top + cr.height * 1.25;
}

export function handleKeydown(ed, e) {
  if (ed.readonly) return;
  if (e.isComposing || e.keyCode === 229) return; // IME 合成中

  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();

  if (mod && key === 'z' && !e.shiftKey) {
    e.preventDefault();
    ed._doUndo();
    return;
  }
  if ((mod && key === 'z' && e.shiftKey) || (mod && key === 'y')) {
    e.preventDefault();
    ed._doRedo();
    return;
  }
  if (mod) return;

  const selRange = ed._selectionSrcRange();
  if (selRange && (e.key === 'Backspace' || e.key === 'Delete')) {
    e.preventDefault();
    ed._deleteSelection();
    return;
  }

  // 跨入代码块的上下键：渲染态代码块不含围栏行（比编辑态源码少两行），
  // 浏览器按几何落点会跳过近端围栏（下行、上行都先落代码行），空代码块
  // 更会被整体跳过。在单元首/末视觉行处改为直接激活代码块编辑态：
  // 下行 → 源码行首（```js 行），上行 → 源码行尾（闭栏行）
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.shiftKey) {
    const cc = ed._actionableCaret();
    if (cc && !cc.unit.lines && onEdgeVisualLine(cc, e.key === 'ArrowDown')) {
      const idx = ed.doc.units.indexOf(cc.unit);
      const adj = e.key === 'ArrowDown' ? ed.doc.units[idx + 1] : ed.doc.units[idx - 1];
      if (adj && adj.kind === 'code') {
        e.preventDefault();
        ed._activate(adj, e.key === 'ArrowDown' ? 0 : adj.range[1] - adj.range[0]);
      }
    }
    return; // 其余上下键（含多行单元内的行间移动）交给浏览器默认
  }

  const c = ed._ensureActiveCaret();
  if (!c) return;
  const u = c.unit;
  const srcOff = c.srcOff;
  const elOff = srcOff == null ? 0 : srcOff - u.range[0];

  if (e.key === 'Enter') {
    e.preventDefault();
    // 代码块/表格内一律插换行（表格不加硬换行空格，避免拆坏行结构）
    if (u.kind === 'code' || u.kind === 'table') {
      ed.doc.splice(srcOff, srcOff, '\n');
      ed._applyStructural(srcOff + 1, { typing: true });
      return;
    }
    const ins = e.shiftKey ? '  \n' : '\n';
    ed.doc.splice(srcOff, srcOff, ins);
    ed._applyStructural(srcOff + ins.length, { typing: true });
    return;
  }

  if (e.key === 'Tab') {
    if (u.kind === 'code') {
      e.preventDefault();
      ed.doc.splice(srcOff, srcOff, '  ');
      ed._applyStructural(srcOff + 2, { typing: true });
      return;
    }
    e.preventDefault();
    if (u.kind === 'item') {
      ed._applyStructural(ed.doc.indentItem(u, e.shiftKey ? -2 : 2));
    }
    return;
  }

  if (e.key === 'Backspace') {
    // 行首判定：源码行首（elOff 0）或内容首（标记前缀之后——前缀为悬浮/绝对定位，
    // 光标通常无法进入，内容首即用户感知的行首）
    const prefixLen = u.textStart != null ? u.textStart - u.range[0] : 0;
    if (elOff === 0 || elOff === prefixLen) {
      e.preventDefault();
      const caret = ed.doc.stripLayer(u) ?? ed.doc.joinPrev(u);
      if (caret != null) ed._applyStructural(caret);
      return;
    }
    return; // 非行首：浏览器默认删除，input 事件同步
  }

  if (e.key === 'Delete') {
    if (srcOff >= u.range[1]) {
      e.preventDefault();
      const caret = ed.doc.joinNext(u);
      if (caret != null) ed._applyStructural(caret);
    }
  }
}
