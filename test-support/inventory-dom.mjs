// Minimal DOM boundary for the inventory adapter. Mutation delivery is explicit
// so tests can check that mutations caused by mounting converge without loops.
export function createInventoryDOM(onRender = () => {}) {
  const observers = [];
  const roots = [];
  function changed(target, type, attributeName) {
    for (const observer of observers) {
      if (!observer.target || !observer.target.contains(target)) continue;
      const options = observer.options;
      if (type === 'attributes' && (!options.attributes || !options.attributeFilter.includes(attributeName))) continue;
      if (type === 'childList' && !options.childList) continue;
      observer.pending = true;
    }
  }
  class Element {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.attributes = new Map(); this.parent = null; this.dataset = {}; }
    get isConnected() { return document.body.contains(this) || document.head.contains(this); }
    appendChild(child) {
      child.remove();
      child.parent = this;
      this.children.push(child);
      changed(this, 'childList');
      return child;
    }
    remove() {
      if (!this.parent) return;
      const parent = this.parent;
      parent.children.splice(parent.children.indexOf(this), 1);
      this.parent = null;
      changed(parent, 'childList');
    }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = String(value);
      changed(this, 'attributes', name);
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) {
      this.attributes.delete(name);
      if (name.startsWith('data-')) delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())];
      changed(this, 'attributes', name);
    }
    querySelectorAll(selector) {
      const matches = node => selector.split(',').some(part => {
        const match = part.trim().match(/^(\w+)?\[([^=\]]+)(?:="([^"]*)")?\]$/);
        if (!match) throw new Error(`Unsupported test DOM selector: ${part}`);
        return (!match[1] || node.tagName === match[1]) && node.attributes.has(match[2]) && (match[3] === undefined || node.getAttribute(match[2]) === match[3]);
      });
      return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  }
  const document = {
    body: new Element('body'), head: new Element('head'),
    createElement: name => new Element(name),
    querySelectorAll: selector => document.body.querySelectorAll(selector),
    getElementById: id => document.body.querySelectorAll('[id]').find(node => node.getAttribute('id') === id) ?? null
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.pending = false; this.disconnected = false; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.target = null; this.pending = false; this.disconnected = true; }
  }
  function flush() {
    for (let pass = 0; observers.some(observer => observer.pending); pass++) {
      if (pass > 10) throw new Error('Inventory adapter did not converge after its own DOM mutations');
      for (const observer of observers) if (observer.pending) {
        observer.pending = false;
        observer.callback([]);
      }
    }
  }
  function card(moduleName = '@icanotcode/dsh-feishu-bot', open = true) {
    const element = document.createElement('li');
    const button = document.createElement('button');
    const details = document.createElement('div');
    const id = `details-${++nextCard}`;
    element.setAttribute('data-plugin-module', moduleName);
    element.setAttribute('data-open', String(open));
    button.setAttribute('aria-controls', id);
    details.setAttribute('id', id);
    element.appendChild(button);
    element.appendChild(details);
    document.body.appendChild(element);
    return { element, button, details };
  }
  let nextCard = 0;
  const reactDOM = { createRoot(container) {
    const root = { container, renders: [], unmounts: 0,
      render(vnode) { this.renders.push(vnode); onRender(vnode); },
      unmount() { this.unmounts++; }
    };
    roots.push(root);
    return root;
  } };
  return { document, MutationObserver, reactDOM, card, flush, roots, observers };
}
