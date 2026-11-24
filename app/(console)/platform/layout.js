// The operator console. Old screens put themselves in a [data-legacy] region
// (page.js, loading.js, error.js) so they keep the old tokens under the
// console's .console body (app/console.css); new ones (onboarding/, Phase 1
// line 8) are built on components/ui and stay outside it.
export default function PlatformLayout({ children }) {
  return children;
}
