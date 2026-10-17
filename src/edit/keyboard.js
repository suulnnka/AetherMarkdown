// 键盘行为（D34 行块模型）
//
//  - Enter = 分行：插入换行符，光标到新行行首（新行是真实的空行块）
//  - Shift+Enter = 短间距行：插入"两空格+换行"（下一行渲染为短间距）
//  - 行首 Backspace = 剥一层语法（标题→文字行、列表行降级/转文字行、引用降层），
//    已是最简形态则与上一行合并（行直接拼接）
//  - 行尾 Delete = 与下一行合并
//  - Tab：列表行整体缩进 ±2 空格；代码块内插入两空格；其余无操作

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
