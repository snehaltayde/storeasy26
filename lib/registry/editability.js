// P4-SCAFFOLD (MIG-01, ED-05): which document types the founder edits in the
// new editor. Pure: no database, no request, no node: imports; edge-safe.
// MAPPER (the dry run) and CUTOVER read these instead of the service's code.
//
//   typeHasEditor(typeName)  true when the type is registered, editable and
//                            not a system document (journal_index is false)
//   cartEditable()           the doc_cart ruling (plan OQ-6, default): the
//                            cart slot is edited in the new editor. P4-LIVEROW
//                            makes lib/documents/service.js match (it removes
//                            refuseCart there); until then the service still
//                            refuses cart writes, and nothing reads this yet.
import { documentType } from "./index.js";

export const CART_EDITABLE = true;

export function typeHasEditor(typeName) {
  const t = documentType(typeName);
  return !!t && t.editable === true && t.system !== true;
}

export const cartEditable = () => CART_EDITABLE;
