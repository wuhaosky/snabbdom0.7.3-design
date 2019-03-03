/* global module, document, Node */
import {Module} from './modules/module';
import {Hooks} from './hooks';
import vnode, {VNode, VNodeData, Key} from './vnode';
import * as is from './is';
import htmlDomApi, {DOMAPI} from './htmldomapi';

function isUndef(s: any): boolean { return s === undefined; }
function isDef(s: any): boolean { return s !== undefined; }

type VNodeQueue = Array<VNode>;

const emptyNode = vnode('', {}, [], undefined, undefined);

function sameVnode(vnode1: VNode, vnode2: VNode): boolean {
  return vnode1.key === vnode2.key && vnode1.sel === vnode2.sel;
}

function isVnode(vnode: any): vnode is VNode {
  return vnode.sel !== undefined;
}

type KeyToIndexMap = {[key: string]: number};

type ArraysOf<T> = {
  [K in keyof T]: (T[K])[];
}

type ModuleHooks = ArraysOf<Module>;

// 为 vnode 数组 begin～end 下标范围内的 vnode 创建它的 key 和 下标 的映射。
function createKeyToOldIdx(children: Array<VNode>, beginIdx: number, endIdx: number): KeyToIndexMap {
  let i: number, map: KeyToIndexMap = {}, key: Key | undefined, ch;
  // 遍历 vnode 数组，如果 vnode 有 key，记录这个 vnode 的下标
  for (i = beginIdx; i <= endIdx; ++i) {
    ch = children[i];
    if (ch != null) {
      key = ch.key;
      if (key !== undefined) map[key] = i;
    }
  }
  return map;
}

// hook name | 所处阶段 | 参数
const hooks: (keyof Module)[] = ['create', 'update', 'remove', 'destroy', 'pre', 'post'];

export {h} from './h';
export {thunk} from './thunk';

export function init(modules: Array<Partial<Module>>, domApi?: DOMAPI) {
  let i: number, j: number, cbs = ({} as ModuleHooks);

  const api: DOMAPI = domApi !== undefined ? domApi : htmlDomApi;
  // 从 modules 初始化 hooks
  for (i = 0; i < hooks.length; ++i) {
    cbs[hooks[i]] = [];
    for (j = 0; j < modules.length; ++j) {
      const hook = modules[j][hooks[i]];
      if (hook !== undefined) {
        (cbs[hooks[i]] as Array<any>).push(hook);
      }
    }
  }
  // 为实际 dom 创建 vnode
  function emptyNodeAt(elm: Element) {
    const id = elm.id ? '#' + elm.id : '';
    const c = elm.className ? '.' + elm.className.split(' ').join('.') : '';
    return vnode(api.tagName(elm).toLowerCase() + id + c, {}, [], undefined, elm);
  }
  // 创建 remove 回调函数
  function createRmCb(childElm: Node, listeners: number) {
    return function rmCb() {
      // 在所有 listeners 被执行后才删除 dom
      if (--listeners === 0) {
        const parent = api.parentNode(childElm);
        api.removeChild(parent, childElm);
      }
    };
  }

  // 为 vnode（tree） 创建 真实dom (tree)（未插入文档）
  function createElm(vnode: VNode, insertedVnodeQueue: VNodeQueue): Node {
    let i: any, data = vnode.data;
    if (data !== undefined) {
      // 调用 init hook
      if (isDef(i = data.hook) && isDef(i = i.init)) {
        i(vnode);
        // data 可能在 init hook 中被改变，重新获取。
        data = vnode.data;
      }
    }
    let children = vnode.children, sel = vnode.sel;
    // 根据 type 来分别生成 DOM
    if (sel === '!') { // 处理 comment
      if (isUndef(vnode.text)) {
        vnode.text = '';
      }
      vnode.elm = api.createComment(vnode.text as string); // 创建一个注释节点
    } else if (sel !== undefined) { // 处理其它 type
      // Parse selector
      const hashIdx = sel.indexOf('#');
      const dotIdx = sel.indexOf('.', hashIdx);
      const hash = hashIdx > 0 ? hashIdx : sel.length;
      const dot = dotIdx > 0 ? dotIdx : sel.length;
      const tag = hashIdx !== -1 || dotIdx !== -1 ? sel.slice(0, Math.min(hash, dot)) : sel;
      const elm = vnode.elm = isDef(data) && isDef(i = (data as VNodeData).ns) ? api.createElementNS(i, tag)
                                                                               : api.createElement(tag); // 创建一个元素
      if (hash < dot) elm.setAttribute('id', sel.slice(hash + 1, dot)); // 设置元素的id选择器
      if (dotIdx > 0) elm.setAttribute('class', sel.slice(dot + 1).replace(/\./g, ' ')); // 设置元素的类选择器
      for (i = 0; i < cbs.create.length; ++i) cbs.create[i](emptyNode, vnode);
      // 分别处理 children 和 text。
      // 这里隐含一个逻辑：vnode 的 children 和 text 不会同时存在。
      if (is.array(children)) {
        // 递归 children，保证 vnode tree 中每个 vnode 都有自己对应的 dom；
        // 即构建 vnode tree 对应的 dom tree。
        for (i = 0; i < children.length; ++i) {
          const ch = children[i];
          if (ch != null) {
            api.appendChild(elm, createElm(ch as VNode, insertedVnodeQueue));
          }
        }
      } else if (is.primitive(vnode.text)) { // vnode含有text，则创建文本元素，并挂在elm下
        api.appendChild(elm, api.createTextNode(vnode.text));
      }
      // 调用 create hook；为 insert hook 填充 insertedVnodeQueue。
      i = (vnode.data as VNodeData).hook; // Reuse variable
      if (isDef(i)) {
        if (i.create) i.create(emptyNode, vnode);
        if (i.insert) insertedVnodeQueue.push(vnode);
      }
    } else { // 处理 text（sel 是undefined）
      vnode.elm = api.createTextNode(vnode.text as string);
    }
    return vnode.elm;
  }

  // 添加 vnode 数组对应的 dom 到 parent dom
  function addVnodes(parentElm: Node,
                     before: Node | null,
                     vnodes: Array<VNode>,
                     startIdx: number,
                     endIdx: number,
                     insertedVnodeQueue: VNodeQueue) {
    for (; startIdx <= endIdx; ++startIdx) {
      const ch = vnodes[startIdx];
      if (ch != null) {
        api.insertBefore(parentElm, createElm(ch, insertedVnodeQueue), before);
      }
    }
  }

  // 对 vnode 及其 children 递归执行 destroy hook
  function invokeDestroyHook(vnode: VNode) {
    let i: any, j: number, data = vnode.data;
    if (data !== undefined) {
      if (isDef(i = data.hook) && isDef(i = i.destroy)) i(vnode);
      for (i = 0; i < cbs.destroy.length; ++i) cbs.destroy[i](vnode);
      if (vnode.children !== undefined) {
        for (j = 0; j < vnode.children.length; ++j) {
          i = vnode.children[j];
          if (i != null && typeof i !== "string") {
            invokeDestroyHook(i);
          }
        }
      }
    }
  }

  // 从 parent dom 删除 vnode 数组对应的 dom
  function removeVnodes(parentElm: Node,
                        vnodes: Array<VNode>,
                        startIdx: number,
                        endIdx: number): void {
    for (; startIdx <= endIdx; ++startIdx) {
      let i: any, listeners: number, rm: () => void, ch = vnodes[startIdx];
      if (ch != null) {
        if (isDef(ch.sel)) { // 非文本节点
          // 调用 destroy hook
          invokeDestroyHook(ch);
          listeners = cbs.remove.length + 1;
          rm = createRmCb(ch.elm as Node, listeners);
          // 每个 remove 回调执行时 listeners 减 1，所有回调执行完后，才真的删除 dom。
          for (i = 0; i < cbs.remove.length; ++i) cbs.remove[i](ch, rm);
          if (isDef(i = ch.data) && isDef(i = i.hook) && isDef(i = i.remove)) {
            i(ch, rm);
          } else {
            rm();
          }
        } else { // Text node 文本节点
          api.removeChild(parentElm, ch.elm as Node);
        }
      }
    }
  }

  // 比较新旧 children 并更新
  function updateChildren(parentElm: Node,
                          oldCh: Array<VNode>,
                          newCh: Array<VNode>,
                          insertedVnodeQueue: VNodeQueue) {
    let oldStartIdx = 0, newStartIdx = 0;
    let oldEndIdx = oldCh.length - 1;
    let oldStartVnode = oldCh[0];
    let oldEndVnode = oldCh[oldEndIdx];
    let newEndIdx = newCh.length - 1;
    let newStartVnode = newCh[0];
    let newEndVnode = newCh[newEndIdx];
    let oldKeyToIdx: any;
    let idxInOld: number;
    let elmToMove: VNode;
    let before: any;
    // 遍历 oldCh 和 newCh 来比较和更新
    while (oldStartIdx <= oldEndIdx && newStartIdx <= newEndIdx) {
      // 一 首先检查 4 种情况，保证 oldStart/oldEnd/newStart/newEnd 这 4 个 vnode 非空
      // 如果左侧的 vnode 为空就右移下标，如果右侧的 vnode 为空就左移 下标。
      if (oldStartVnode == null) {
        oldStartVnode = oldCh[++oldStartIdx]; // Vnode might have been moved left
      } else if (oldEndVnode == null) {
        oldEndVnode = oldCh[--oldEndIdx];
      } else if (newStartVnode == null) {
        newStartVnode = newCh[++newStartIdx];
      } else if (newEndVnode == null) {
        newEndVnode = newCh[--newEndIdx];
      } 
      // 二 然后 oldStartVnode/oldEndVnode/newStartVnode/newEndVnode 两两比较，
      //  * 对有相同 vnode 的 4 种情况执行对应的 patch 逻辑。
      //  * - 如果同 start 或同 end 的两个 vnode 是相同的（情况 1 和 2），
      //  *   说明不用移动实际 dom，直接更新 dom 属性／children 即可；
      //  * - 如果 start 和 end 两个 vnode 相同（情况 3 和 4），
      //  *   那说明发生了 vnode 的移动，同理我们也要移动 dom。
      // 1. 如果 oldStartVnode 和 newStartVnode 相同（key相同），执行 patch
      else if (sameVnode(oldStartVnode, newStartVnode)) {
        // 不需要移动 dom
        patchVnode(oldStartVnode, newStartVnode, insertedVnodeQueue);
        oldStartVnode = oldCh[++oldStartIdx];
        newStartVnode = newCh[++newStartIdx];
      } 
      // 2. 如果 oldEndVnode 和 newEndVnode 相同，执行 patch
      else if (sameVnode(oldEndVnode, newEndVnode)) {
        // 不需要移动 dom
        patchVnode(oldEndVnode, newEndVnode, insertedVnodeQueue);
        oldEndVnode = oldCh[--oldEndIdx];
        newEndVnode = newCh[--newEndIdx];
      } 
      // 3. 如果 oldStartVnode 和 newEndVnode 相同，执行 patch
      else if (sameVnode(oldStartVnode, newEndVnode)) { // Vnode moved right
        patchVnode(oldStartVnode, newEndVnode, insertedVnodeQueue);
        // 把获得更新后的 (oldStartVnode/newEndVnode) 的 dom 右移，移动到
        // oldEndVnode 对应的 dom 的右边。为什么这么右移？
        // （1）oldStartVnode 和 newEndVnode 相同，显然是 vnode 右移了。
        // （2）若 while 循环刚开始，那移到 oldEndVnode.elm 右边就是最右边，是合理的；
        // （3）若循环不是刚开始，因为比较过程是两头向中间，那么两头的 dom 的位置已经是
        //     合理的了，移动到 oldEndVnode.elm 右边是正确的位置；
        // （4）记住，oldVnode 和 vnode 是相同的才 patch，且 oldVnode 自己对应的 dom
        //     总是已经存在的，vnode 的 dom 是不存在的，直接复用 oldVnode 对应的 dom。
        api.insertBefore(parentElm, oldStartVnode.elm as Node, api.nextSibling(oldEndVnode.elm as Node));
        oldStartVnode = oldCh[++oldStartIdx];
        newEndVnode = newCh[--newEndIdx];
      } 
      // 4. 如果 oldEndVnode 和 newStartVnode 相同，执行 patch
      else if (sameVnode(oldEndVnode, newStartVnode)) { // Vnode moved left
        patchVnode(oldEndVnode, newStartVnode, insertedVnodeQueue);
        // 这里是左移更新后的 dom，原因参考上面的右移。
        api.insertBefore(parentElm, oldEndVnode.elm as Node, oldStartVnode.elm as Node);
        oldEndVnode = oldCh[--oldEndIdx];
        newStartVnode = newCh[++newStartIdx];
      } 
      // 三 最后一种情况：4 个 vnode 都不相同，那么我们就要
      // 1. 从 oldCh 数组建立 key --> index 的 map。
      // 2. 只处理 newStartVnode （简化逻辑，有循环我们最终还是会处理到所有 vnode），
      //    以它的 key 从上面的 map 里拿到 index；
      // 3. 如果 index 存在，那么说明有对应的 old vnode，patch 就好了；
      // 4. 如果 index 不存在，那么说明 newStartVnode 是全新的 vnode，直接
      //    创建对应的 dom 并插入。
      else {
        // 如果 oldKeyToIdx 不存在，创建 old children 中 vnode 的 key 到 index 的
        // 映射，方便我们之后通过 key 去拿下标。
        if (oldKeyToIdx === undefined) {
          oldKeyToIdx = createKeyToOldIdx(oldCh, oldStartIdx, oldEndIdx);
        }
        // 尝试通过 newStartVnode 的 key 去拿下标
        idxInOld = oldKeyToIdx[newStartVnode.key as string];
        // 下标不存在，说明 newStartVnode 是全新的 vnode。
        if (isUndef(idxInOld)) { // New element
          // 那么为 newStartVnode 创建 dom 并插入到 oldStartVnode.elm 的前面。
          api.insertBefore(parentElm, createElm(newStartVnode, insertedVnodeQueue), oldStartVnode.elm as Node);
          newStartVnode = newCh[++newStartIdx];
        } 
        // 下标存在，说明 old children 中有相同 key 的 vnode，
        else {
          elmToMove = oldCh[idxInOld];
          // 如果 type 不同，没办法，只能创建新 dom；
          if (elmToMove.sel !== newStartVnode.sel) {
            api.insertBefore(parentElm, createElm(newStartVnode, insertedVnodeQueue), oldStartVnode.elm as Node);
          } 
          // type 相同（且key相同），那么说明是相同的 vnode，执行 patch。
          else {
            patchVnode(elmToMove, newStartVnode, insertedVnodeQueue);
            oldCh[idxInOld] = undefined as any;
            api.insertBefore(parentElm, (elmToMove.elm as Node), oldStartVnode.elm as Node);
          }
          newStartVnode = newCh[++newStartIdx];
        }
      }
    }
    // 上面的循环结束后（循环条件有两个），处理可能的未处理到的 vnode。 
    if (oldStartIdx <= oldEndIdx || newStartIdx <= newEndIdx) { 
      // 如果是 new vnodes 里有未处理的（oldStartIdx > oldEndIdx 说明 old vnodes 先处理完毕）
      if (oldStartIdx > oldEndIdx) {
        before = newCh[newEndIdx+1] == null ? null : newCh[newEndIdx+1].elm;
        addVnodes(parentElm, before, newCh, newStartIdx, newEndIdx, insertedVnodeQueue);
      } 
      // 相反，如果 old vnodes 有未处理的，删除 （为处理 vnodes 对应的） 多余的 dom。
      else {
        removeVnodes(parentElm, oldCh, oldStartIdx, oldEndIdx);
      }
    }
  }

  // patch oldVnode 和 vnode （它们是相同的 vnode）
  // 1. 更新本身对应 dom 的 textContent/children/其它属性；
  // 2. 根据 children 的变化去决定是否递归 patch children 里的每个 vnode。
  function patchVnode(oldVnode: VNode, vnode: VNode, insertedVnodeQueue: VNodeQueue) {
    let i: any, hook: any;
    if (isDef(i = vnode.data) && isDef(hook = i.hook) && isDef(i = hook.prepatch)) {
      i(oldVnode, vnode);
    }
    // 因为 vnode 和 oldVnode 是相同的 vnode，所以我们可以复用 oldVnode.elm。
    const elm = vnode.elm = (oldVnode.elm as Node);
    let oldCh = oldVnode.children;
    let ch = vnode.children;
    if (oldVnode === vnode) return;
    if (vnode.data !== undefined) {
      for (i = 0; i < cbs.update.length; ++i) cbs.update[i](oldVnode, vnode);
      i = vnode.data.hook;
      if (isDef(i) && isDef(i = i.update)) i(oldVnode, vnode);
    }
    if (isUndef(vnode.text)) { // 1 如果 vnode.text 是 undefined，则比较新旧节点的子节点数组
      // 比较 old children 和 new children，并更新
      if (isDef(oldCh) && isDef(ch)) { // 1.1 新旧子节点数组都有值，则调用updateChildren函数进行进一步比较
        // 核心逻辑（最复杂的地方）：怎么比较新旧 children 并更新
        if (oldCh !== ch) updateChildren(elm, oldCh as Array<VNode>, ch as Array<VNode>, insertedVnodeQueue);
      } else if (isDef(ch)) { // 1.2 只有新节点的子节点数组都有值
        if (isDef(oldVnode.text)) api.setTextContent(elm, ''); // 清空旧节点元素的文本
        addVnodes(elm, null, ch as Array<VNode>, 0, (ch as Array<VNode>).length - 1, insertedVnodeQueue); // 往elm元素上添加子元素
      } else if (isDef(oldCh)) { // 1.3 只有旧节点的子节点数组都有值
        removeVnodes(elm, oldCh as Array<VNode>, 0, (oldCh as Array<VNode>).length - 1); // 移除elm上的子元素
      } else if (isDef(oldVnode.text)) { // 1.4 旧子节点元素含有文本
        api.setTextContent(elm, ''); // 清空旧子节点元素文本
      }
    } else if (oldVnode.text !== vnode.text) { // 2 否则 （vnode 有 text），只要 text 不等，更新 dom 的 text。
      if (isDef(oldCh)) { // 清空旧节点的子节点数组
        removeVnodes(elm, oldCh as Array<VNode>, 0, (oldCh as Array<VNode>).length - 1);
      } // 设置新节点元素的文本
      api.setTextContent(elm, vnode.text as string);
    }
    if (isDef(hook) && isDef(i = hook.postpatch)) {
      i(oldVnode, vnode);
    }
  }

  return function patch(oldVnode: VNode | Element, vnode: VNode): VNode {
    let i: number, elm: Node, parent: Node;
    const insertedVnodeQueue: VNodeQueue = [];
    for (i = 0; i < cbs.pre.length; ++i) cbs.pre[i]();

    if (!isVnode(oldVnode)) { // oldVnode是真实的dom，将其转成vnode
      oldVnode = emptyNodeAt(oldVnode);
    }

    if (sameVnode(oldVnode, vnode)) { // 新旧vnode的key和sel相同，则认为是相同节点，接下来执行patchVnode
      patchVnode(oldVnode, vnode, insertedVnodeQueue);
    } else { // 新旧vnode的key和sel有其一不相同，则认为是不同节点，需要新建元素
      elm = oldVnode.elm as Node;
      parent = api.parentNode(elm); // 获取旧vnode的父元素

      createElm(vnode, insertedVnodeQueue); // 为 vnode（tree） 创建 真实dom (tree)（未插入文档）

      if (parent !== null) { // 如果旧元素有父元素
        api.insertBefore(parent, vnode.elm as Node, api.nextSibling(elm)); // 将新元素插入到父元素中，并指定新插入元素的位置是旧元素之后紧跟的位置。
        removeVnodes(parent, [oldVnode], 0, 0); // 移除旧元素
      }
    }

    for (i = 0; i < insertedVnodeQueue.length; ++i) {
      (((insertedVnodeQueue[i].data as VNodeData).hook as Hooks).insert as any)(insertedVnodeQueue[i]);
    }
    for (i = 0; i < cbs.post.length; ++i) cbs.post[i]();
    return vnode;
  };
}
