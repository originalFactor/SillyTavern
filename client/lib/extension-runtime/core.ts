// Serialized into the opaque-origin frame. Keep dependencies inside this function.
// Semantics follow STOriginal/public/lib/eventemitter.js and scripts/{utils,popup,i18n}.js.
export function installExtensionRuntime(w: any, host: any, events: Record<string, string>, locale: string) {
  const { unsupported, clean, diagnostic } = host;
  type Handler = (...args: any[]) => unknown;
  class EventEmitter {
    events: Record<string, Handler[]> = Object.create(null);
    autoFireLastArgs = new Map<string, any[]>();
    autoFireAfterEmit: Set<string>;
    constructor(autoFireAfterEmit: string[] = []) { this.autoFireAfterEmit = new Set(autoFireAfterEmit); }
    on(event: string, listener: Handler) {
      if (event === undefined) return;
      (this.events[event] ??= []).push(listener);
      if (this.autoFireAfterEmit.has(event) && this.autoFireLastArgs.has(event)) listener.apply(this, this.autoFireLastArgs.get(event)!);
    }
    removeListener(event: string, listener: Handler) {
      const list = this.events[event]; const index = list?.indexOf(listener) ?? -1;
      if (index >= 0) list.splice(index, 1);
    }
    off(event: string, listener: Handler) { this.removeListener(event, listener); }
    once(event: string, listener: Handler) {
      const emitter = this;
      this.on(event, function once(this: EventEmitter, ...args: any[]) { emitter.removeListener(event, once); listener.apply(this, args); });
    }
    makeFirst(event: string, listener: Handler) { this.removeListener(event, listener); (this.events[event] ??= []).unshift(listener); this.replay(event, listener); }
    makeLast(event: string, listener: Handler) { this.removeListener(event, listener); this.on(event, listener); }
    private replay(event: string, listener: Handler) { if (this.autoFireAfterEmit.has(event) && this.autoFireLastArgs.has(event)) listener.apply(this, this.autoFireLastArgs.get(event)!); }
    async emit(event: string, ...args: any[]) {
      for (const listener of [...(this.events[event] ?? [])]) {
        try { await listener.apply(this, args); } catch (error) { diagnostic(error); }
      }
      if (this.autoFireAfterEmit.has(event)) this.autoFireLastArgs.set(event, args);
    }
    emitAndWait(event: string, ...args: any[]) {
      for (const listener of [...(this.events[event] ?? [])]) {
        try { listener.apply(this, args); } catch (error) { diagnostic(error); }
      }
      if (this.autoFireAfterEmit.has(event)) this.autoFireLastArgs.set(event, args);
    }
  }
  const eventSource = new EventEmitter([events.APP_READY, events.APP_INITIALIZED]);
  const debounceMap = new WeakMap<Handler, ReturnType<typeof setTimeout>>();
  const utils = {
    regexFromString(input: string) {
      try {
        const match = input.match(/(\/?)(.+)\1([a-z]*)/i)!;
        if (match[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(match[3])) return RegExp(input);
        return new RegExp(match[2], match[3]);
      } catch { return undefined; }
    },
    delay: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    debounce(func: Handler, timeout = 300) {
      let timer: ReturnType<typeof setTimeout>;
      const fn = (...args: any[]) => { clearTimeout(timer); timer = setTimeout(() => func(...args), timeout); debounceMap.set(func, timer); debounceMap.set(fn, timer); };
      return fn;
    },
    cancelDebounce(func: Handler) { clearTimeout(debounceMap.get(func)); debounceMap.delete(func); },
    throttle(func: Handler, limit = 300) {
      let lastCall: number | undefined;
      return (...args: any[]) => { const now = Date.now(); if (lastCall === undefined || now - lastCall >= limit) { lastCall = now; func(...args); } };
    },
    uuidv4: () => w.crypto.randomUUID(),
    isTrueBoolean: (value?: string) => ["true", "1", "on"].includes(value?.trim().toLowerCase() ?? ""),
    isFalseBoolean: (value?: string) => ["false", "0", "off"].includes(value?.trim().toLowerCase() ?? ""),
    isOdd: (n: number) => n % 2 !== 0,
    countOccurrences(string: string, character: string) {
      let count = 0;
      for (let i = 0; i < string.length; i++) if (string.substring(i, i + character.length) === character) count++;
      return count;
    },
    async getSanitizedFilename(fileName: unknown) {
      // The upstream helper calls files/sanitize-filename. Mirror that route's
      // String conversion and sanitize-filename rules locally, without legacy HTTP.
      const input = String(fileName);
      if (!input) throw Error("A filename is required.");
      const reserved = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;
      const trimEnd = (value: string) => {
        let end = value.length;
        while (end > 0 && (value[end - 1] === "." || value[end - 1] === " ")) end--;
        return value.slice(0, end);
      };
      const value = trimEnd(input.replace(/[/?<>\\:*|"\u0000-\u001f\u0080-\u009f]/g, "").replace(/^\.+$/, "").replace(reserved, ""));
      let bytes = 0, length = 0;
      for (const segment of value) {
        const point = segment.codePointAt(0)!;
        const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
        if (bytes + size > 255) break;
        bytes += size; length += segment.length;
      }
      return trimEnd(value.slice(0, length)).replace(reserved, "");
    },
    getCharaFilename(_chid: string | number | null = null, { manualAvatarKey = null }: { manualAvatarKey?: string | null } = {}) {
      if (manualAvatarKey == null) return unsupported("getCharaFilename (character catalog/selection is not bound; pass manualAvatarKey)");
      return manualAvatarKey.replace(/\.[^/.]+$/, "");
    },
    download(..._args: any[]) { return unsupported("download (sandbox downloads are unavailable)"); },
    async showFontAwesomePicker(customList: string[][] | null = null): Promise<string | null> {
      if (customList == null) return unsupported("showFontAwesomePicker (default icon inventory is not packaged; pass customList)");
      if (!Array.isArray(customList) || customList.length > 4096 || Array.from(customList).some(aliases => !Array.isArray(aliases) || !aliases.length || aliases.length > 32 || Array.from(aliases).some(name => typeof name !== "string" || name.length > 128 || !/^fa-[a-z0-9-]+$/.test(name)))) throw Error("Invalid or oversized Font Awesome icon list.");
      // Own the list while the modal is open; labels remain usable without fonts.
      const icons = customList.map(aliases => [...aliases]);
      const dom = w.document.createElement("div"); dom.className = "faPicker-container";
      const query = w.document.createElement("input"); query.type = "search"; query.className = "faQuery"; query.placeholder = "Filter icons"; query.autofocus = true;
      const grid = w.document.createElement("div"); grid.className = "faPicker";
      dom.append(query, grid);
      let value = "";
      const picker = new Popup(dom, POPUP_TYPE.TEXT, "", { allowVerticalScrolling: true, okButton: "No Icon", cancelButton: "Cancel" });
      const options = icons.map(aliases => {
        const option = w.document.createElement("button"); option.type = "button";
        option.className = `menu_button fa-solid ${aliases[0]}`; option.textContent = aliases[0]; option.title = aliases.map(name => name.slice(3)).join(", ");
        option.dataset.result = String(POPUP_RESULT.AFFIRMATIVE);
        option.addEventListener("click", () => { value = aliases[0]; void picker.completeAffirmative().catch(diagnostic); });
        grid.append(option); return option;
      });
      query.addEventListener("input", () => {
        const text = query.value.toLowerCase();
        for (let i = 0; i < icons.length; i++) options[i].hidden = !icons[i].some(alias => alias.includes(text));
      });
      await picker.show();
      return picker.result === POPUP_RESULT.AFFIRMATIVE ? value : null;
    },
    clamp: (value: number, min: number, max: number) => Math.min(Math.max(value, min), max),
    escapeRegex: (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    escapeHtml: (text: string) => String(text ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!),
    sanitizeSelector: (text: string, replacement = "_") => text.replace(/[^a-zA-Z0-9_-]/g, replacement),
    onlyUnique: (value: unknown, index: number, array: unknown[]) => array.indexOf(value) === index,
    removeFromArray(array: unknown[], item: unknown) { const index = array.indexOf(item); if (index >= 0) array.splice(index, 1); return index >= 0; },
    isDataURL: (value: string) => typeof value === "string" && /^data:([a-z]+\/[a-z0-9-+.]+(;[a-z-]+=[a-z0-9-]+)*;?)?(base64)?,([a-z0-9!$&',()*+;=\-_%.~:@/?#]+)?$/i.test(value),
    getFileText: (file: Blob) => file.text(),
    getFileBuffer: (file: Blob) => file.arrayBuffer(),
    getBase64Async: (file: Blob) => new Promise((resolve, reject) => { const reader = new w.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }),
    getImageSizeFromDataURL: (dataUrl: string) => new Promise<{ width: number; height: number }>((resolve, reject) => {
      if (!dataUrl.startsWith("data:") && !dataUrl.startsWith("blob:")) { reject(new Error("Only local data/blob images are available in the extension host.")); return; }
      const image = new w.Image();
      image.onload = () => resolve({ width: image.width, height: image.height });
      image.onerror = () => reject(new Error("Failed to load image"));
      image.src = dataUrl;
    }),
    supportedImageMimeTypes: Object.freeze(["image/jpeg", "image/png", "image/bmp", "image/tiff", "image/gif", "image/apng", "image/webp", "image/avif"]),
    async ensureImageFormatSupported(file: File): Promise<File> {
      if (utils.supportedImageMimeTypes.includes(file.type) || !file.type.startsWith("image/")) return file;
      return utils.convertImageFile(file, "image/png");
    },
    async convertImageFile(file: File, type = "image/png"): Promise<File> {
      const url = w.URL.createObjectURL(file);
      try {
        const image = new w.Image();
        await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("Failed to load image")); image.src = url; });
        const canvas = w.document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext("2d"); if (!ctx) throw Error("Image conversion is unavailable.");
        ctx.fillStyle = "white"; ctx.fillRect(0, 0, image.width, image.height);
        ctx.drawImage(image, 0, 0);
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob: Blob | null) => blob ? resolve(blob) : reject(new Error("Failed to convert image")), type));
        return new w.File([blob], file.name, { type });
      } finally { w.URL.revokeObjectURL(url); }
    },
    async waitUntilCondition(condition: () => boolean, timeout = 1000, interval = 100, { rejectOnTimeout = true } = {}) {
      return new Promise<void | Error>((resolve, reject) => {
        const timeoutId = setTimeout(() => { clearInterval(intervalId); const error = Error("Timed out waiting for condition to be true"); if (rejectOnTimeout) reject(error); else resolve(error); }, timeout);
        const intervalId = setInterval(() => { if (condition()) { clearTimeout(timeoutId); clearInterval(intervalId); resolve(); } }, interval);
      });
    },
    getStringHash(str: string, seed = 0) {
      if (typeof str !== "string") return 0;
      let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
      for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
      h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
      h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
      return 4294967296 * (2097151 & h2) + (h1 >>> 0);
    },
    Stopwatch: class {
      interval: number; lastAction = Date.now();
      constructor(interval: number) { this.interval = Number.isFinite(interval) && interval > 0 ? interval : 1; }
      async tick(action: () => unknown) { if (Date.now() - this.lastAction < this.interval) return; await action(); this.lastAction = Date.now(); }
    },
  };
  locale = locale.toLowerCase();
  const localeData = new Map<string, Record<string, string>>();
  const translate = (text: string, key = text) => localeData.get(locale)?.[key] ?? text;
  const t = (text: TemplateStringsArray | string, ...values: any[]) => {
    if (typeof text === "string") return translate(text);
    const key = text.reduce((result, part, i) => result + part + (i < values.length ? `\u0024{${i}}` : ""), "");
    return translate(key).replace(/\$\{(\d+)\}/g, (_, index) => String(values[Number(index)]));
  };
  const applyLocale = (root = w.document) => {
    const element = typeof root === "string" ? w.document.createElement("div") : root;
    if (typeof root === "string") element.innerHTML = clean(root);
    for (const node of element.querySelectorAll("[data-i18n]")) {
      for (const key of node.getAttribute("data-i18n").split(";")) {
        const attr = key.match(/^\[([^\]]+)\](.*)$/);
        if (attr && ["title", "placeholder", "aria-label"].includes(attr[1])) node.setAttribute(attr[1], translate(node.getAttribute(attr[1]) ?? "", attr[2]));
        else if (!attr) node.textContent = translate(node.textContent ?? "", key);
      }
    }
    return typeof root === "string" ? element.innerHTML : undefined;
  };
  const i18n = { t, translate, getCurrentLocale: () => locale, addLocaleData(language: string, data: Record<string, string>) {
    if (language !== locale) return;
    localeData.set(language, { ...data, ...localeData.get(language) });
  }, applyLocale };
  const POPUP_TYPE = Object.freeze({ TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 });
  const POPUP_RESULT = Object.freeze({ AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null, ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`CUSTOM${i + 1}`, 1001 + i])) });
  class Popup {
    dlg = w.document.createElement("dialog");
    content = w.document.createElement("div");
    mainInput = w.document.createElement("textarea");
    result: number | null | undefined;
    value: unknown;
    inputResults?: Map<string, string | boolean>;
    onOpen: any; onClosing: any; onClose: any;
    defaultResult: number | null;
    private inputs = new Map<string, any>();
    private closing = false;
    private finish?: (value: unknown) => void;
    private shown?: Promise<unknown>;
    constructor(content: any, public type: number, inputValue = "", public options: any = {}) {
      if (type === POPUP_TYPE.CROP) unsupported("Popup.CROP");
      this.onOpen = options.onOpen; this.onClosing = options.onClosing; this.onClose = options.onClose;
      this.defaultResult = options.defaultResult ?? POPUP_RESULT.AFFIRMATIVE;
      this.dlg.classList.add("popup");
      if (typeof content === "string") this.content.innerHTML = clean(content);
      else if (content?.jquery) this.content.append(...content.toArray());
      else if (content instanceof w.Node) this.content.append(content);
      this.dlg.append(this.content);
      if (type === POPUP_TYPE.INPUT) { this.mainInput.value = inputValue; this.mainInput.rows = options.rows ?? 1; this.mainInput.placeholder = options.placeholder ?? ""; this.dlg.append(this.mainInput); }
      for (const input of options.customInputs ?? []) {
        if (typeof input.id !== "string" || !input.id || this.inputs.has(input.id)) throw Error("Invalid or duplicate popup input ID.");
        const inputType = input.type ?? "checkbox";
        if (!["checkbox", "text", "textarea", "number"].includes(inputType)) unsupported(`Popup input type: ${inputType}`);
        const label = w.document.createElement("label"); label.textContent = input.label ?? "";
        const control = w.document.createElement(inputType === "textarea" ? "textarea" : "input");
        control.id = input.id;
        if (inputType !== "textarea") control.type = inputType;
        control.value = String(input.defaultState ?? ""); control.checked = Boolean(input.defaultState ?? false);
        control.disabled = Boolean(input.disabled); control.placeholder = input.tooltip ?? ""; control.title = input.tooltip ?? "";
        if (input.autoFocus) control.setAttribute("autofocus", "");
        if (inputType === "textarea") control.rows = input.rows ?? 1;
        if (inputType === "number") for (const key of ["min", "max", "step"]) if (input[key] != null) control[key] = String(input[key]);
        label.append(control); this.dlg.append(label); this.inputs.set(input.id, control);
      }
      const button = (label: string, result: number | null | undefined, spec: any = {}) => {
        const el = w.document.createElement("button"); el.textContent = label; el.title = spec.tooltip ?? "";
        el.dataset.result = String(result);
        if (spec.classes) el.classList.add(...(Array.isArray(spec.classes) ? spec.classes : [spec.classes]));
        if (spec.icon) { const icon = w.document.createElement("i"); icon.className = `fa-solid ${spec.icon}`; el.prepend(icon); }
        el.addEventListener("click", () => { spec.action?.(); if (result !== undefined) void this.complete(result).catch(diagnostic); });
        this.dlg.append(el);
      };
      const customButtons = (options.customButtons ?? []).map((spec: any, index: number) => typeof spec === "string" ? { text: spec, result: index + 2 } : spec);
      for (const spec of customButtons.filter((spec: any) => !spec.appendAtEnd)) button(spec.text, spec.result, spec);
      if (type !== POPUP_TYPE.DISPLAY && options.okButton !== false) button(typeof options.okButton === "string" ? options.okButton : "OK", 1);
      if (type === 4 || ([2, 3].includes(type) ? options.cancelButton !== false : options.cancelButton)) button(typeof options.cancelButton === "string" ? options.cancelButton : "Cancel", type === 4 ? null : 0);
      for (const spec of customButtons.filter((spec: any) => spec.appendAtEnd)) button(spec.text, spec.result, spec);
      this.dlg.addEventListener("cancel", (event: Event) => { event.preventDefault(); if (options.allowEscapeClose !== false) void this.complete(null).catch(diagnostic); });
      Popup.util.popups.push(this);
    }
    show() {
      if (!this.shown) {
        this.shown = new Promise(resolve => { this.finish = resolve; });
        w.document.body.append(this.dlg); this.dlg.showModal();
        Promise.resolve(this.onOpen?.(this)).catch(diagnostic);
      }
      return this.shown;
    }
    async complete(result: number | null) {
      if (!this.finish || this.closing) return;
      this.closing = true;
      try {
        this.result = result;
        this.value = this.type === 3 ? result === null ? null : result >= 1 ? this.mainInput.value : false : result;
        if (this.inputs.size) this.inputResults = new Map([...this.inputs].map(([id, input]) => [id, input.type === "checkbox" ? input.checked : input.value]));
        if (this.onClosing && !await this.onClosing(this)) { this.result = undefined; this.value = undefined; this.inputResults = undefined; return; }
        Popup.util.lastResult = { value: this.value, result, inputResults: this.inputResults };
        this.dlg.close();
        await this.onClose?.(this);
        this.dlg.remove(); utils.removeFromArray(Popup.util.popups, this);
        const finish = this.finish; this.finish = undefined; finish(this.value);
        return this.value;
      } finally { this.closing = false; }
    }
    completeAffirmative() { return this.complete(1); }
    completeNegative() { return this.complete(0); }
    completeCancelled() { return this.complete(null); }
    static show = {
      text: (header: string, text: string, options = {}) => new Popup(Popup.BuildTextWithHeader(header, text), 1, "", options).show(),
      confirm: (header: string, text: string, options = {}) => new Popup(Popup.BuildTextWithHeader(header, text), 2, "", options).show(),
      input: async (header: string, text: string, value = "", options = {}) => { const result = await new Popup(Popup.BuildTextWithHeader(header, text), 3, value, options).show(); return result === "" ? "" : result ? String(result) : null; },
    };
    static util: { popups: Popup[]; lastResult: any; isPopupOpen: () => boolean; getTopmostModalLayer: () => any } = {
      popups: [], lastResult: null,
      isPopupOpen: () => Popup.util.popups.some(popup => popup.dlg.open),
      getTopmostModalLayer: () => [...Popup.util.popups].reverse().find(popup => popup.dlg.open)?.dlg ?? w.document.body,
    };
    static BuildTextWithHeader(header: string, text: string) { return `<h3>${utils.escapeHtml(header)}</h3>${text}`; }
  }
  const popup = { Popup, PopupUtils: { BuildTextWithHeader: Popup.BuildTextWithHeader }, POPUP_TYPE, POPUP_RESULT, callGenericPopup: (content: any, type: number, value = "", options = {}) => new Popup(content, type, value, options).show() };
  return { EventEmitter, eventSource, events, utils, i18n, popup };
}
