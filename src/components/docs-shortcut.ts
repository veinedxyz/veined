// Parser-executed, request-nonced bootstrap. The shortcut must work on the
// server-rendered input even while the React bundles are still loading.
// Capture before React's selective hydration can stop a discrete event. One
// delegated listener also covers client navigation; no wallet or network IO.
export const docsShortcutBootstrap = `(()=>{const marker=Symbol.for("veined.docs.shortcut");if(window[marker])return;document.addEventListener("keydown",function(event){if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"){const input=document.getElementById("docs-search");if(input instanceof HTMLInputElement){event.preventDefault();input.focus();input.select();}}},true);window[marker]=true;})();`;
