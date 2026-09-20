export class DocumentationDisclosure {
  static openTarget(hash: string): void {
    if (!hash.startsWith("#")) return;
    const target = document.getElementById(hash.slice(1));
    let disclosure = target instanceof HTMLDetailsElement ? target : target?.closest("details");

    while (disclosure instanceof HTMLDetailsElement) {
      disclosure.open = true;
      disclosure = disclosure.parentElement?.closest("details");
    }
  }

  static handleToggle(event: Event): void {
    const disclosure = event.target;
    if (!(disclosure instanceof HTMLDetailsElement) || !disclosure.open) return;

    if (disclosure.classList.contains("docs-disclosure")) {
      const content = disclosure.querySelector<HTMLElement>(":scope > .docs-disclosure__content");
      const openItem = content?.querySelector<HTMLDetailsElement>(":scope > .docs-accordion[open]");
      if (!openItem) content?.querySelector<HTMLDetailsElement>(":scope > .docs-accordion")?.setAttribute("open", "");
    }
  }
}
