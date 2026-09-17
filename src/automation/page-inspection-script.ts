export class PageInspectionScript {
  static readonly SOURCE = `
    const maxItems = arguments[0];
    const maxTextLength = arguments[1];
    const selector = "a,button,input,textarea,select,[role],[contenteditable='true'],h1,h2,h3";
    const cssSelector = element => {
      if (element.id) return "#" + CSS.escape(element.id);
      if (element.dataset.testid) return "[data-testid=" + JSON.stringify(element.dataset.testid) + "]";
      const ariaLabel = element.getAttribute("aria-label");
      if (ariaLabel) return "[aria-label=" + JSON.stringify(ariaLabel) + "]";
      const placeholder = element.getAttribute("placeholder");
      if (placeholder) return "[placeholder=" + JSON.stringify(placeholder) + "]";
      const name = element.getAttribute("name");
      if (name) return element.tagName.toLowerCase() + "[name=" + JSON.stringify(name) + "]";

      const path = [];
      let current = element;
      while (current) {
        let segment = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(child => child.tagName === current.tagName);
          if (siblings.length > 1) segment += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        }
        path.unshift(segment);
        if (!parent || current === document.body) break;
        current = parent;
      }
      return path.join(" > ");
    };

    return Array.from(document.querySelectorAll(selector)).slice(0, maxItems).map(element => ({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") || undefined,
      type: element.getAttribute("type") || undefined,
      text: (element.innerText || element.textContent || "").trim().replace(/\\s+/g, " ").slice(0, maxTextLength) || undefined,
      label: element.getAttribute("aria-label") || (element.id ? document.querySelector("label[for=\\\"" + CSS.escape(element.id) + "\\\"]")?.textContent?.trim() : undefined) || element.getAttribute("name") || undefined,
      value: "value" in element ? String(element.value) : undefined,
      selector: cssSelector(element),
      disabled: "disabled" in element ? Boolean(element.disabled) : false,
      checked: "checked" in element ? Boolean(element.checked) : undefined
    }));
  `;
}
