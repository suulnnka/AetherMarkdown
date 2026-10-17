// 撤销栈（architecture.md §7）：源文本 + 光标快照，块级单元
//
// 快照为"操作后状态"。同单元连续输入（500ms 内）合并为一个单元；
// 结构操作各自独立。栈深超限丢弃最旧。

export class UndoStack {
  constructor(limit = 200) {
    this.limit = limit;
    this.stack = [];
    this.redoStack = [];
  }

  // entry: {source, caret, unitId, typing, t}
  push(entry) {
    entry.t = Date.now();
    const top = this.stack[this.stack.length - 1];
    if (entry.typing && top && top.typing && top.unitId === entry.unitId && entry.t - top.t < 500) {
      this.stack[this.stack.length - 1] = entry;
    } else {
      this.stack.push(entry);
      if (this.stack.length > this.limit) this.stack.shift();
    }
    this.redoStack = [];
  }

  reset(entry) {
    entry.t = Date.now();
    this.stack = [entry];
    this.redoStack = [];
  }

  canUndo() {
    return this.stack.length > 1;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  // current 为当前状态；返回目标快照（栈存"操作后状态"，栈顶即当前，
  // undo 需弹掉当前并返回前一状态）
  undo(current) {
    if (!this.canUndo()) return null;
    this.redoStack.push(current);
    this.stack.pop();
    return this.stack[this.stack.length - 1];
  }

  redo(current) {
    if (!this.canRedo()) return null;
    this.stack.push(current);
    return this.redoStack.pop();
  }
}
