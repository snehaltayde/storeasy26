import { BadgeCheck, ChartBar, Megaphone, MessageCircle, Puzzle, ShieldCheck, Star, Truck } from "lucide-react";

// A plugin's icon by its manifest name (lib/plugins/manifest.js PLUGIN_ICONS).
const ICONS = { BadgeCheck, ChartBar, Megaphone, MessageCircle, Puzzle, ShieldCheck, Star, Truck };

export function PluginIcon({ name, className }) {
  const Icon = ICONS[name] || Puzzle;
  return <Icon aria-hidden="true" className={className} />;
}
