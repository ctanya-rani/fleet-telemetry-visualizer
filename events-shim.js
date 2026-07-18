/* Minimal browser stand-in for node:events. The demo page's import map
   points "node:events" here so server/simulator.js runs unchanged in the
   browser. Only what the simulator and demo backend use: on/off/emit. */
export class EventEmitter {
  #listeners = new Map();

  on(event, fn) {
    let list = this.#listeners.get(event);
    if (!list) {
      list = [];
      this.#listeners.set(event, list);
    }
    list.push(fn);
    return this;
  }

  off(event, fn) {
    const list = this.#listeners.get(event);
    if (list) {
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    }
    return this;
  }

  emit(event, ...args) {
    const list = this.#listeners.get(event);
    if (!list || list.length === 0) return false;
    for (const fn of [...list]) fn(...args);
    return true;
  }
}
