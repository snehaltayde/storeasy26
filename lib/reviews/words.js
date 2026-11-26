// Phase 9 line 1: the words shoppers read on the review pages, in one place so
// the suite runs the banned-copy scan over them.
import { LIMITS } from "./store.js";

export const WRITE_WORDS = Object.freeze({
  thanks: "Thanks. Your review will appear once the store has read it.",
  privacy: "We never show your email.",
  fix: "Some answers need fixing. Check the marked fields and send it again.",
  server: "Your review couldn't be sent just now. Please try again.",
});
export const FIELD_WORDS = Object.freeze({
  rating: "Choose from 1 to 5 stars.",
  title: `Keep the title to ${LIMITS.title} characters.`,
  body: `Write ${LIMITS.bodyMin} to ${LIMITS.bodyMax} characters.`,
  display_name: `Add a name of up to ${LIMITS.name} characters.`,
});
export const OPTOUT_WORDS = Object.freeze({
  ask: "Stop review emails from this store? You'll still get emails about your orders.",
  done: "Done. This store won't ask you for reviews again.",
  refused: "This link isn't valid. Use the link in your most recent review email.",
});
