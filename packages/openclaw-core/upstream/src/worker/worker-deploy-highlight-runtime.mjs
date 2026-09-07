// Literal require is bundled into a synchronous initializer, loaded only on demand.
export default function loadHighlightJs() {
  return require("highlight.js");
}
