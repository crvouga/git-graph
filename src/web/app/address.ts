// Where the app's URL lives. In the browser it is the address bar; in Storybook each story gets an
// in-memory URL so navigation never rewrites the Storybook iframe's own address.

import { IN_STORYBOOK } from "./env.ts";

export interface Address {
  /** Absolute URL of the current view. */
  href(): string;
  /** path + search, compared against serialized view URLs. */
  path(): string;
  hash(): string;
  push(url: string): void;
  replace(url: string): void;
  /** Called when the URL changes from outside the app (Back/Forward). */
  onPop(fn: () => void): void;
}

const browserAddress: Address = {
  href: () => location.href,
  path: () => location.pathname + location.search,
  hash: () => location.hash,
  push: (url) => history.pushState(null, "", url),
  replace: (url) => history.replaceState(null, "", url),
  onPop: (fn) => window.addEventListener("popstate", fn),
};

/** In-memory address with its own back stack. */
export function memoryAddress(initial = "/"): Address & { back(): void; entries(): string[] } {
  const stack = [new URL(initial, "http://memory.local")];
  let i = 0;
  const listeners: (() => void)[] = [];
  const cur = () => stack[i]!;
  return {
    href: () => cur().href,
    path: () => cur().pathname + cur().search,
    hash: () => cur().hash,
    push(url) {
      stack.splice(i + 1, Infinity, new URL(url, cur()));
      i = stack.length - 1;
    },
    replace(url) {
      stack[i] = new URL(url, cur());
    },
    onPop: (fn) => void listeners.push(fn),
    back() {
      if (i === 0) return;
      i--;
      for (const fn of listeners) fn();
    },
    entries: () => stack.map((u) => u.pathname + u.search),
  };
}

/** Stories navigate inside this; the harness reads and rewinds it. Null outside Storybook. */
export const storyAddress = IN_STORYBOOK ? memoryAddress("/") : null;

let current: Address = storyAddress ?? browserAddress;

export const address: Address = {
  href: () => current.href(),
  path: () => current.path(),
  hash: () => current.hash(),
  push: (url) => current.push(url),
  replace: (url) => current.replace(url),
  onPop: (fn) => current.onPop(fn),
};
